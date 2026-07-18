import { afterEach, describe, expect, it } from 'vitest';
import { OutpostError } from '@outpost/shared-api';
import {
  authorizeUrl,
  callbackUrl,
  generateState,
  loadGithubConfig,
  resolveGithubUser,
  verifyState,
  type Fetcher,
} from '../auth/github.js';
import {
  generateSessionToken,
  hashSessionToken,
  sessionCookieOptions,
  clearCookieOptions,
  cookieOptions,
  sessionExpiry,
  SESSION_TTL_MS,
} from '../auth/session.js';
import { isAllowed, parseAllowedIds } from '../auth/middleware.js';
import { loadBootConfig, stripUrlQuery } from '../index.js';

const config = { clientId: 'id', clientSecret: 'secret', baseUrl: 'https://x.example' };

afterEach(() => {
  delete process.env.OUTPOST_ALLOWED_GITHUB_IDS;
  delete process.env.OUTPOST_INSECURE_COOKIES;
});

describe('github helpers', () => {
  it('generateState returns 64 hex chars (32 bytes)', () => {
    expect(generateState()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifyState uses constant-time equality, false on mismatch/missing', () => {
    const s = generateState();
    expect(verifyState(s, s)).toBe(true);
    expect(verifyState(s, 'nope')).toBe(false);
    expect(verifyState(undefined, s)).toBe(false);
    expect(verifyState(s, undefined)).toBe(false);
  });

  it('callbackUrl is derived from baseUrl and never hardcoded', () => {
    expect(callbackUrl(config)).toBe('https://x.example/auth/callback');
    expect(callbackUrl({ ...config, baseUrl: 'https://x.example/' })).toBe(
      'https://x.example/auth/callback',
    );
  });

  it('authorizeUrl includes client_id, state, and env-derived redirect_uri', () => {
    const url = authorizeUrl(config, 'abc');
    expect(url).toContain('client_id=id');
    expect(url).toContain('state=abc');
    expect(url).toContain(encodeURIComponent('https://x.example/auth/callback'));
  });

  it('loadGithubConfig throws loudly when a var is missing', () => {
    expect(() => loadGithubConfig({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b' })).toThrow(
      /OUTPOST_BASE_URL/,
    );
  });

  it('resolveGithubUser throws UPSTREAM_ERROR and leaks no token on failure', async () => {
    const failing: Fetcher = async () => new Response('boom', { status: 500 });
    await expect(resolveGithubUser(config, 'code', failing)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      httpStatus: 502,
    });
    const err = await resolveGithubUser(config, 'code', failing).catch((e) => e);
    expect(err).toBeInstanceOf(OutpostError);
    expect(String(err)).not.toContain('code');
  });

  it('resolveGithubUser returns { id, login } on success', async () => {
    const ok: Fetcher = async (url) =>
      url.includes('access_token')
        ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
        : new Response(JSON.stringify({ id: 583231, login: 'octocat' }), { status: 200 });
    await expect(resolveGithubUser(config, 'code', ok)).resolves.toEqual({
      id: 583231,
      login: 'octocat',
    });
  });

  it('resolveGithubUser rejects a user payload missing a numeric id', async () => {
    const badId: Fetcher = async (url) =>
      url.includes('access_token')
        ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
        : new Response(JSON.stringify({ login: 'octocat' }), { status: 200 });
    await expect(resolveGithubUser(config, 'code', badId)).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      httpStatus: 502,
    });
  });
});

describe('session helpers', () => {
  it('token is 64 hex chars and hash is deterministic sha256 hex', () => {
    const t = generateSessionToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSessionToken(t)).toBe(hashSessionToken(t));
    expect(hashSessionToken(t)).not.toBe(t);
  });

  it('sessionExpiry is TTL ahead of now', () => {
    const now = new Date(1000);
    expect(sessionExpiry(now).getTime()).toBe(1000 + SESSION_TTL_MS);
  });

  it('cookie is Secure by default, insecure only behind the dev flag', () => {
    expect(sessionCookieOptions({}).secure).toBe(true);
    expect(sessionCookieOptions({ OUTPOST_INSECURE_COOKIES: '1' }).secure).toBe(false);
    const opts = sessionCookieOptions({});
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
  });

  it('clearCookieOptions echoes the set-cookie flags minus maxAge', () => {
    const set = cookieOptions(123, {});
    const clear = clearCookieOptions({});
    expect(clear).toEqual({
      httpOnly: set.httpOnly,
      sameSite: set.sameSite,
      path: set.path,
      secure: set.secure,
    });
    expect('maxAge' in clear).toBe(false);
    expect(clearCookieOptions({ OUTPOST_INSECURE_COOKIES: '1' }).secure).toBe(false);
  });
});

describe('allowlist', () => {
  it('parses comma-separated numeric ids, trimmed, drops empties', () => {
    expect(parseAllowedIds({ OUTPOST_ALLOWED_GITHUB_IDS: ' 1, 22 ,,333 ' })).toEqual([1, 22, 333]);
    expect(parseAllowedIds({})).toEqual([]);
  });

  it('parseAllowedIds fails loud on a non-numeric entry', () => {
    expect(() => parseAllowedIds({ OUTPOST_ALLOWED_GITHUB_IDS: '1,octocat,3' })).toThrow(
      /non-numeric/,
    );
  });

  it('isAllowed is numeric-id membership', () => {
    const env = { OUTPOST_ALLOWED_GITHUB_IDS: '583231' };
    expect(isAllowed(583231, env)).toBe(true);
    expect(isAllowed(999, env)).toBe(false);
  });
});

describe('url log serializer', () => {
  it('strips the query string so the OAuth code never reaches logs', () => {
    const stripped = stripUrlQuery('/auth/callback?code=SECRET&state=x');
    expect(stripped).toBe('/auth/callback');
    expect(stripped).not.toContain('SECRET');
  });

  it('leaves a query-less path unchanged', () => {
    expect(stripUrlQuery('/auth/me')).toBe('/auth/me');
  });
});

describe('boot config', () => {
  it('fails loud when the allowlist is empty', () => {
    expect(() => loadBootConfig({ GITHUB_CLIENT_ID: 'a', GITHUB_CLIENT_SECRET: 'b', OUTPOST_BASE_URL: 'https://x' })).toThrow(
      /OUTPOST_ALLOWED_GITHUB_IDS/,
    );
  });

  it('fails loud on a non-numeric allowlist entry', () => {
    expect(() =>
      loadBootConfig({
        OUTPOST_ALLOWED_GITHUB_IDS: '583231,not-a-number',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
        OUTPOST_BASE_URL: 'https://x',
      }),
    ).toThrow(/non-numeric/);
  });

  it('fails loud when github env is missing', () => {
    expect(() => loadBootConfig({ OUTPOST_ALLOWED_GITHUB_IDS: '1' })).toThrow(
      /GITHUB_CLIENT_ID/,
    );
  });

  const fullEnv = {
    OUTPOST_ALLOWED_GITHUB_IDS: '1',
    GITHUB_CLIENT_ID: 'id',
    GITHUB_CLIENT_SECRET: 'secret',
    OUTPOST_BASE_URL: 'https://x',
    FLY_API_TOKEN: 'fly-token',
    FLY_SANDBOX_APP: 'my-sandbox-app',
    FLY_REGION: 'iad',
    OUTPOST_SANDBOX_IMAGE: 'ghcr.io/outpost/sandbox:latest',
    OUTPOST_COLLECTOR_ENDPOINT: 'http://collector:4318',
    OUTPOST_COLLECTOR_TOKEN: 'x'.repeat(32),
    OUTPOST_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
  };

  it('fails loud when OUTPOST_MASTER_KEY is missing', () => {
    expect(() => loadBootConfig({ ...fullEnv, OUTPOST_MASTER_KEY: undefined })).toThrow(
      /OUTPOST_MASTER_KEY is required/,
    );
  });

  it('fails loud when OUTPOST_MASTER_KEY is not 32 bytes base64', () => {
    expect(() => loadBootConfig({ ...fullEnv, OUTPOST_MASTER_KEY: 'dG9vLXNob3J0' })).toThrow(
      /32 bytes base64/,
    );
  });

  it('fails loud when OUTPOST_COLLECTOR_TOKEN is missing', () => {
    expect(() => loadBootConfig({ ...fullEnv, OUTPOST_COLLECTOR_TOKEN: undefined })).toThrow(
      /OUTPOST_COLLECTOR_TOKEN is required/,
    );
  });

  it('fails loud when OUTPOST_COLLECTOR_TOKEN is shorter than 32 chars', () => {
    const err = (() => {
      try {
        loadBootConfig({ ...fullEnv, OUTPOST_COLLECTOR_TOKEN: 'short' });
        return null;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).toMatch(/at least 32 characters/);
    // The error must never echo the token value.
    expect(err?.message).not.toContain('short');
  });

  it('returns config when everything is set', () => {
    const config = loadBootConfig(fullEnv);
    expect(config.githubConfig.clientId).toBe('id');
    expect(config.fly.apiToken).toBe('fly-token');
    expect(config.sandbox.image).toBe('ghcr.io/outpost/sandbox:latest');
    expect(config.sandbox.collectorToken).toBe('x'.repeat(32));
  });
});
