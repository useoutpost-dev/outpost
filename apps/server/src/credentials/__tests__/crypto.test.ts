import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encryptSecret, decryptSecret, _resetKeyCache } from '../crypto.js';

// Two distinct valid 32-byte base64 seeds.
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

function setKey(k: string | undefined): void {
  if (k === undefined) delete process.env.OUTPOST_MASTER_KEY;
  else process.env.OUTPOST_MASTER_KEY = k;
  _resetKeyCache();
}

afterEach(() => setKey(undefined));

describe('credential crypto', () => {
  beforeEach(() => setKey(KEY_A));

  it('roundtrips plaintext through encrypt/decrypt', async () => {
    const secret = 'sk-ant-super-secret-123';
    const ct = await encryptSecret(secret);
    expect(ct).not.toContain(secret);
    expect(await decryptSecret(ct)).toBe(secret);
  });

  it('produces different ciphertext each call (sealed box is randomized)', async () => {
    const a = await encryptSecret('same');
    const b = await encryptSecret('same');
    expect(a).not.toBe(b);
  });

  it('decrypt with a different master key fails', async () => {
    const ct = await encryptSecret('payload');
    setKey(KEY_B);
    await expect(decryptSecret(ct)).rejects.toMatchObject({ code: 'INTERNAL', httpStatus: 500 });
  });

  it('missing master key throws INTERNAL and never echoes the key', async () => {
    setKey(undefined);
    await expect(encryptSecret('x')).rejects.toMatchObject({ code: 'INTERNAL', httpStatus: 500 });
  });

  it('malformed (wrong length) master key throws INTERNAL', async () => {
    setKey(Buffer.alloc(16, 9).toString('base64'));
    await expect(encryptSecret('x')).rejects.toMatchObject({ code: 'INTERNAL', httpStatus: 500 });
  });
});
