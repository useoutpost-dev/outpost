import { describe, it, expect } from 'vitest';
import {
  CLAUDE_CREDENTIALS_PATH,
  CLAUDE_CREDENTIALS_ENV,
  encodeCredentialsForEnv,
  decodeCredentialsFromEnv,
  validateCredentialsBlob,
} from '../credentials.js';

// Obviously-fake fixture: never a real token.
const FIXTURE = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-FAKE',
    refreshToken: 'sk-ant-ort-FAKE',
    expiresAt: 1893456000000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  },
});

describe('constants', () => {
  it('exposes the frozen in-sandbox credential path', () => {
    expect(CLAUDE_CREDENTIALS_PATH).toBe('/home/outpost/.claude/.credentials.json');
  });

  it('exposes the frozen env var name', () => {
    expect(CLAUDE_CREDENTIALS_ENV).toBe('OUTPOST_CLAUDE_CREDENTIALS_B64');
  });
});

describe('encode/decode roundtrip', () => {
  it('roundtrips a credential blob', () => {
    const encoded = encodeCredentialsForEnv(FIXTURE);
    expect(decodeCredentialsFromEnv(encoded)).toBe(FIXTURE);
  });

  it('roundtrips unicode content', () => {
    const unicode = JSON.stringify({ claudeAiOauth: { note: 'café — 日本語 — 🔒' } });
    const encoded = encodeCredentialsForEnv(unicode);
    expect(decodeCredentialsFromEnv(encoded)).toBe(unicode);
  });

  it('produces valid base64 output', () => {
    const encoded = encodeCredentialsForEnv(FIXTURE);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});

describe('decodeCredentialsFromEnv error handling', () => {
  it('throws a plain Error on invalid base64', () => {
    expect(() => decodeCredentialsFromEnv('not valid base64 !!!')).toThrowError(Error);
  });

  it('throws on empty input', () => {
    expect(() => decodeCredentialsFromEnv('')).toThrow();
  });

  it('does not leak decoded contents in the error message', () => {
    // A string that decodes to something but is not clean base64.
    let message = '';
    try {
      decodeCredentialsFromEnv('@@@@');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe('invalid base64 in Claude credentials env value');
  });
});

describe('validateCredentialsBlob', () => {
  it('accepts a realistic fixture', () => {
    expect(validateCredentialsBlob(FIXTURE)).toBe(true);
  });

  it('accepts a minimal blob with only required fields', () => {
    const minimal = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'b' },
    });
    expect(validateCredentialsBlob(minimal)).toBe(true);
  });

  it('rejects non-JSON', () => {
    expect(validateCredentialsBlob('not json {')).toBe(false);
  });

  it('rejects a JSON array', () => {
    expect(validateCredentialsBlob('[]')).toBe(false);
  });

  it('rejects a JSON string primitive', () => {
    expect(validateCredentialsBlob('"hello"')).toBe(false);
  });

  it('rejects missing claudeAiOauth', () => {
    expect(validateCredentialsBlob(JSON.stringify({ other: {} }))).toBe(false);
  });

  it('rejects claudeAiOauth that is not an object', () => {
    expect(validateCredentialsBlob(JSON.stringify({ claudeAiOauth: 'x' }))).toBe(false);
  });

  it('rejects empty accessToken', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: 'b' } });
    expect(validateCredentialsBlob(blob)).toBe(false);
  });

  it('rejects missing refreshToken', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'a' } });
    expect(validateCredentialsBlob(blob)).toBe(false);
  });

  it('rejects non-string tokens', () => {
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 1, refreshToken: 2 } });
    expect(validateCredentialsBlob(blob)).toBe(false);
  });
});
