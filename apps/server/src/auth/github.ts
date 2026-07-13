import crypto from 'node:crypto';
import { OutpostError } from '@outpost/shared-api';

/**
 * Injectable fetcher so tests can stub GitHub network calls (no real network in CI).
 * Mirrors the subset of the global fetch signature we depend on.
 */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface GithubConfig {
  clientId: string;
  clientSecret: string;
  /** Base URL of this Outpost instance; the callback URL is derived from it, never hardcoded. */
  baseUrl: string;
}

const STATE_COOKIE = 'outpost_oauth_state';
const STATE_TTL_SECONDS = 10 * 60; // 10 minutes

/**
 * Load and validate GitHub OAuth config from the environment.
 * Throws a loud error (used at boot) if any required var is missing.
 */
export function loadGithubConfig(env: NodeJS.ProcessEnv = process.env): GithubConfig {
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const baseUrl = env.OUTPOST_BASE_URL?.trim();

  const missing: string[] = [];
  if (!clientId) missing.push('GITHUB_CLIENT_ID');
  if (!clientSecret) missing.push('GITHUB_CLIENT_SECRET');
  if (!baseUrl) missing.push('OUTPOST_BASE_URL');
  if (missing.length > 0) {
    throw new Error(`missing required GitHub OAuth env vars: ${missing.join(', ')}`);
  }

  return { clientId: clientId!, clientSecret: clientSecret!, baseUrl: baseUrl! };
}

/** The env-driven OAuth callback URL. Never hardcoded. */
export function callbackUrl(config: GithubConfig): string {
  return `${config.baseUrl.replace(/\/$/, '')}/auth/callback`;
}

export const STATE_COOKIE_NAME = STATE_COOKIE;
export const STATE_COOKIE_TTL_SECONDS = STATE_TTL_SECONDS;

/** 32 random bytes hex, used as the CSRF state param. */
export function generateState(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Constant-time comparison of two state strings; false on any length/format mismatch. */
export function verifyState(expected: string | undefined, actual: string | undefined): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Build the GitHub authorize URL to redirect the browser to. */
export function authorizeUrl(config: GithubConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(config),
    scope: 'read:user',
    state,
    allow_signup: 'false',
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for an access token.
 * Never logs or returns the code, client secret, or access token in errors.
 */
async function exchangeCodeForToken(
  config: GithubConfig,
  code: string,
  fetcher: Fetcher,
): Promise<string> {
  let res: Response;
  try {
    res = await fetcher('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: callbackUrl(config),
      }),
    });
  } catch {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github token exchange failed');
  }

  if (!res.ok) {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github token exchange failed');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github token exchange failed');
  }

  const token =
    body && typeof body === 'object' && typeof (body as Record<string, unknown>).access_token === 'string'
      ? ((body as Record<string, unknown>).access_token as string)
      : undefined;

  if (!token) {
    // GitHub returns 200 with an { error } body on failure; do not surface it.
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github token exchange failed');
  }
  return token;
}

/** Identity of the authenticated GitHub user. The id is immutable and is the allowlist key. */
export interface GithubUser {
  id: number;
  login: string;
}

/**
 * Fetch the authenticated user's id and login using an access token.
 * The id is the immutable numeric user ID; the login is for display only.
 * Never logs or returns the access token in errors.
 */
async function fetchGithubUser(token: string, fetcher: Fetcher): Promise<GithubUser> {
  let res: Response;
  try {
    res = await fetcher('https://api.github.com/user', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'outpost',
      },
    });
  } catch {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github user lookup failed');
  }

  if (!res.ok) {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github user lookup failed');
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github user lookup failed');
  }

  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const id = record?.id;
  const login = record?.login;

  if (typeof id !== 'number' || !Number.isFinite(id) || typeof login !== 'string' || login.length === 0) {
    throw new OutpostError('UPSTREAM_ERROR', 502, 'github user lookup failed');
  }
  return { id, login };
}

/**
 * Full callback exchange: code -> access token -> github user.
 * Returns only the id and login; the access token never leaves this function.
 */
export async function resolveGithubUser(
  config: GithubConfig,
  code: string,
  fetcher: Fetcher = fetch,
): Promise<GithubUser> {
  const token = await exchangeCodeForToken(config, code, fetcher);
  return fetchGithubUser(token, fetcher);
}
