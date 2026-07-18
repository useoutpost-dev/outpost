import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { CLAUDE_CREDENTIALS_ENV } from '@outpost/claude-adapters';
import { accounts, events, sandboxes } from '../../db/schema.js';
import { createCredentialsService } from '../service.js';
import { _resetKeyCache } from '../crypto.js';
import { makeTestDb, makeFakeProvider } from '../../__tests__/helpers.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

beforeEach(() => {
  process.env.OUTPOST_MASTER_KEY = KEY;
  _resetKeyCache();
});
afterEach(() => {
  delete process.env.OUTPOST_MASTER_KEY;
});

const VALID_BLOB = JSON.stringify({
  claudeAiOauth: { accessToken: 'at-abc', refreshToken: 'rt-xyz', expiresAt: 123 },
});

describe('credentials service — createAccount', () => {
  it('api_key: stores ciphertext, DB row never contains plaintext key', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    const key = 'sk-ant-plaintext-should-not-persist';

    const pub = await svc.createAccount({ label: 'work', kind: 'api_key', apiKey: key });
    expect(pub).toMatchObject({ label: 'work', kind: 'api_key', hasCredentials: true });
    expect(JSON.stringify(pub)).not.toContain(key);

    const row = db.select().from(accounts).where(eq(accounts.id, pub.id)).get()!;
    expect(row.encryptedKey).toBeTruthy();
    expect(row.encryptedKey).not.toContain(key);
    // Whole raw row, serialized, must not leak the plaintext.
    expect(JSON.stringify(row)).not.toContain(key);

    // Event payload contains label+kind only, no key.
    const ev = db.select().from(events).all().find((e) => e.kind === 'account.created')!;
    expect(ev.payload).toEqual({ label: 'work', kind: 'api_key' });
    expect(JSON.stringify(ev.payload)).not.toContain(key);
  });

  it('api_key without apiKey: 400', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    await expect(svc.createAccount({ label: 'x', kind: 'api_key' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      httpStatus: 400,
    });
  });

  it('subscription: stores no secret, hasCredentials false', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    const pub = await svc.createAccount({ label: 'sub', kind: 'subscription' });
    expect(pub.hasCredentials).toBe(false);
    const row = db.select().from(accounts).where(eq(accounts.id, pub.id)).get()!;
    expect(row.encryptedKey).toBeNull();
    expect(row.encryptedCredentials).toBeNull();
  });

  it('duplicate label: 409', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    await svc.createAccount({ label: 'dupe', kind: 'subscription' });
    await expect(svc.createAccount({ label: 'dupe', kind: 'subscription' })).rejects.toMatchObject({
      code: 'CONFLICT',
      httpStatus: 409,
    });
  });
});

describe('credentials service — envForAccount', () => {
  it('api_key account yields ANTHROPIC_API_KEY with the decrypted value', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    const key = 'sk-ant-live-1';
    const pub = await svc.createAccount({ label: 'k', kind: 'api_key', apiKey: key });
    const env = await svc.envForAccount(pub.id);
    expect(env).toEqual({ ANTHROPIC_API_KEY: key });
  });

  it('subscription without creds yields empty env', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    const pub = await svc.createAccount({ label: 's', kind: 'subscription' });
    expect(await svc.envForAccount(pub.id)).toEqual({});
  });

  it('unknown account: 404', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    await expect(svc.envForAccount('nope')).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

describe('credentials service — remove', () => {
  it('404 for unknown', () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    expect(() => svc.remove('nope')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });

  it('409 when a non-destroyed sandbox references it', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    const pub = await svc.createAccount({ label: 'used', kind: 'subscription' });
    db.insert(sandboxes)
      .values({ id: 'sbx-1', name: 'a', provider: 'fly', status: 'running', accountId: pub.id })
      .run();
    expect(() => svc.remove(pub.id)).toThrow(expect.objectContaining({ code: 'CONFLICT' }));
  });

  it('deletes when only destroyed sandboxes reference it', async () => {
    const db = makeTestDb();
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    const pub = await svc.createAccount({ label: 'freeable', kind: 'subscription' });
    db.insert(sandboxes)
      .values({ id: 'sbx-2', name: 'b', provider: 'fly', status: 'destroyed', accountId: pub.id })
      .run();
    svc.remove(pub.id);
    expect(db.select().from(accounts).where(eq(accounts.id, pub.id)).get()).toBeUndefined();
  });
});

describe('credentials service — captureFromSandbox', () => {
  function subAccount(db: ReturnType<typeof makeTestDb>) {
    const svc = createCredentialsService({ db, provider: makeFakeProvider() });
    return svc;
  }

  it('valid blob on a running subscription sandbox: stores ciphertext (not plaintext), returns true', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    provider.exec = async () => ({ exitCode: 0, stdout: VALID_BLOB, stderr: '' });
    const svc = createCredentialsService({ db, provider });
    const acct = await svc.createAccount({ label: 'cap', kind: 'subscription' });

    const ok = await svc.captureFromSandbox({
      accountId: acct.id,
      providerRef: 'machine-1',
      status: 'running',
    });
    expect(ok).toBe(true);

    const row = db.select().from(accounts).where(eq(accounts.id, acct.id)).get()!;
    expect(row.encryptedCredentials).toBeTruthy();
    expect(row.encryptedCredentials).not.toContain('at-abc');
    expect(row.encryptedCredentials).not.toContain('rt-xyz');
  });

  it('invalid blob: not stored, returns false', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    provider.exec = async () => ({ exitCode: 0, stdout: '{"nope":true}', stderr: '' });
    const svc = createCredentialsService({ db, provider });
    const acct = await svc.createAccount({ label: 'cap2', kind: 'subscription' });

    const ok = await svc.captureFromSandbox({
      accountId: acct.id,
      providerRef: 'machine-1',
      status: 'running',
    });
    expect(ok).toBe(false);
    const row = db.select().from(accounts).where(eq(accounts.id, acct.id)).get()!;
    expect(row.encryptedCredentials).toBeNull();
  });

  it('exec non-zero exit: returns false, does not throw', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    provider.exec = async () => ({ exitCode: 1, stdout: '', stderr: 'no file' });
    const svc = createCredentialsService({ db, provider });
    const acct = await svc.createAccount({ label: 'cap3', kind: 'subscription' });
    expect(
      await svc.captureFromSandbox({ accountId: acct.id, providerRef: 'm', status: 'running' }),
    ).toBe(false);
  });

  it('provider.exec throwing: returns false (best-effort)', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    provider.exec = async () => {
      throw new Error('exec unavailable');
    };
    const svc = createCredentialsService({ db, provider });
    const acct = await svc.createAccount({ label: 'cap4', kind: 'subscription' });
    expect(
      await svc.captureFromSandbox({ accountId: acct.id, providerRef: 'm', status: 'running' }),
    ).toBe(false);
  });

  it('non-running sandbox: returns false', async () => {
    const db = makeTestDb();
    const svc = subAccount(db);
    const acct = await svc.createAccount({ label: 'cap5', kind: 'subscription' });
    expect(
      await svc.captureFromSandbox({ accountId: acct.id, providerRef: 'm', status: 'stopped' }),
    ).toBe(false);
  });

  it('subscription with captured creds: envForAccount injects the credential env', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    provider.exec = async () => ({ exitCode: 0, stdout: VALID_BLOB, stderr: '' });
    const svc = createCredentialsService({ db, provider });
    const acct = await svc.createAccount({ label: 'cap6', kind: 'subscription' });
    await svc.captureFromSandbox({ accountId: acct.id, providerRef: 'm', status: 'running' });

    const env = await svc.envForAccount(acct.id);
    expect(Object.keys(env)).toEqual([CLAUDE_CREDENTIALS_ENV]);
    // encoded blob is base64 of the file content — decodes back to the blob.
    expect(Buffer.from(env[CLAUDE_CREDENTIALS_ENV]!, 'base64').toString('utf8')).toBe(VALID_BLOB);
  });
});
