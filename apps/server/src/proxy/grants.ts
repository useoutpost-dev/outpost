import crypto from 'node:crypto';

export const PREVIEW_GRANT_COOKIE_NAME = '__Host-outpost_preview';
export const PREVIEW_GRANT_TTL_MS = 5 * 60 * 1000;

export interface PreviewGrantAudience {
  sandboxId: string;
  port: number;
}

interface GrantRecord extends PreviewGrantAudience {
  expiresAt: number;
}

export interface PreviewGrantStoreOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

/**
 * In-memory, opaque preview grants for the single-user server process.
 * Exchange codes are one-time; preview-cookie tokens are scoped to one sandbox
 * and port. Only SHA-256 token hashes are retained server-side.
 */
export class PreviewGrantStore {
  private readonly exchangeCodes = new Map<string, GrantRecord>();
  private readonly sessions = new Map<string, GrantRecord>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: PreviewGrantStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? PREVIEW_GRANT_TTL_MS;
    this.maxEntries = opts.maxEntries ?? 2048;
  }

  mint(audience: PreviewGrantAudience): { code: string; expiresAt: number } {
    this.prune();
    this.makeRoom(this.exchangeCodes);
    const code = randomToken();
    const expiresAt = this.now() + this.ttlMs;
    this.exchangeCodes.set(hashToken(code), { ...audience, expiresAt });
    return { code, expiresAt };
  }

  exchange(
    code: string | undefined,
    audience: PreviewGrantAudience,
  ): { token: string; expiresAt: number } | null {
    if (!code) return null;
    this.prune();
    const key = hashToken(code);
    const record = this.exchangeCodes.get(key);
    // Every presented code is consumed, including an audience mismatch.
    this.exchangeCodes.delete(key);
    if (!record || !sameAudience(record, audience) || record.expiresAt <= this.now()) return null;

    this.makeRoom(this.sessions);
    const token = randomToken();
    this.sessions.set(hashToken(token), record);
    return { token, expiresAt: record.expiresAt };
  }

  authorize(token: string | undefined, audience: PreviewGrantAudience): boolean {
    if (!token) return false;
    this.prune();
    const record = this.sessions.get(hashToken(token));
    return Boolean(record && sameAudience(record, audience) && record.expiresAt > this.now());
  }

  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.exchangeCodes) {
      if (record.expiresAt <= now) this.exchangeCodes.delete(key);
    }
    for (const [key, record] of this.sessions) {
      if (record.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private makeRoom(map: Map<string, GrantRecord>): void {
    while (map.size >= this.maxEntries) {
      const oldest = map.keys().next().value as string | undefined;
      if (!oldest) return;
      map.delete(oldest);
    }
  }
}

function randomToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sameAudience(a: PreviewGrantAudience, b: PreviewGrantAudience): boolean {
  return a.sandboxId === b.sandboxId && a.port === b.port;
}
