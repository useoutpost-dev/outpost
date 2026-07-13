import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { events, sessions, type SessionRow } from '../db/schema.js';
import { hashSessionToken, sessionExpiry } from './session.js';

export type AuthEventKind = 'login' | 'denied' | 'logout';

/** Append an auth event with the github id and login in the payload. */
export function appendAuthEvent(
  db: Db,
  kind: AuthEventKind,
  identity: { githubId: number; githubLogin: string },
): void {
  db.insert(events)
    .values({ kind: `auth.${kind}`, payload: identity })
    .run();
}

/**
 * Create a session row keyed by the sha256 hash of the raw token.
 * Caller owns the raw token (sent to the client as the cookie value).
 * Stores the immutable github id (allowlist key) plus the login for display.
 */
export function createSession(
  db: Db,
  rawToken: string,
  identity: { githubId: number; githubLogin: string },
  now: Date = new Date(),
): SessionRow {
  const id = hashSessionToken(rawToken);
  const expiresAt = sessionExpiry(now);
  const { githubId, githubLogin } = identity;
  db.insert(sessions).values({ id, githubId, githubLogin, createdAt: now, expiresAt }).run();
  return { id, githubId, githubLogin, createdAt: now, expiresAt };
}

/**
 * Look up a session by raw token. Expired rows are deleted and treated as absent.
 * Returns the row only if present and unexpired.
 */
export function lookupSession(db: Db, rawToken: string, now: Date = new Date()): SessionRow | undefined {
  const id = hashSessionToken(rawToken);
  const rows = db.select().from(sessions).where(eq(sessions.id, id)).all();
  const row = rows[0];
  if (!row) return undefined;
  if (row.expiresAt.getTime() <= now.getTime()) {
    db.delete(sessions).where(eq(sessions.id, id)).run();
    return undefined;
  }
  return row;
}

/** Delete a session by raw token (logout / revocation). */
export function deleteSession(db: Db, rawToken: string): void {
  const id = hashSessionToken(rawToken);
  db.delete(sessions).where(eq(sessions.id, id)).run();
}
