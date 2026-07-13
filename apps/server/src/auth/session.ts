import crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'outpost_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Raw cookie token: 32 random bytes hex. The raw token is only ever sent to the client. */
export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** DB primary key = sha256 hex of the raw token. The raw token never touches the DB. */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  path: '/';
  secure: boolean;
  maxAge: number;
}

/** The flags a clearCookie must echo for the browser to accept the clear. */
export type ClearCookieOptions = Omit<CookieOptions, 'maxAge'>;

/**
 * Shared cookie flags used by both the session and state cookies.
 * The two cookies differ only in maxAge, so it is the single parameter here.
 * Secure is on by default and only dropped when OUTPOST_INSECURE_COOKIES=1,
 * a dev-only escape hatch for plain-HTTP local development. Never set it in prod.
 */
export function cookieOptions(maxAge: number, env: NodeJS.ProcessEnv = process.env): CookieOptions {
  const insecure = env.OUTPOST_INSECURE_COOKIES === '1';
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: !insecure,
    maxAge,
  };
}

/**
 * The clear-flags for any cookie set via cookieOptions. Browsers may ignore a
 * clearCookie whose httpOnly/secure/sameSite/path do not match the set cookie,
 * so clears must reuse these exact attributes.
 */
export function clearCookieOptions(env: NodeJS.ProcessEnv = process.env): ClearCookieOptions {
  const { httpOnly, sameSite, path, secure } = cookieOptions(0, env);
  return { httpOnly, sameSite, path, secure };
}

/** Cookie flags for the session cookie (7 day TTL). */
export function sessionCookieOptions(env: NodeJS.ProcessEnv = process.env): CookieOptions {
  return cookieOptions(Math.floor(SESSION_TTL_MS / 1000), env);
}

/** Expiry timestamp for a session created now. */
export function sessionExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}
