import { describe, expect, it } from 'vitest';
import { PreviewGrantStore } from '../grants.js';

describe('PreviewGrantStore', () => {
  it('exchanges once and authorizes only the exact audience', () => {
    const store = new PreviewGrantStore();
    const audience = { sandboxId: 'sb-1', port: 3000 };
    const { code } = store.mint(audience);
    const session = store.exchange(code, audience);

    expect(session).not.toBeNull();
    expect(store.exchange(code, audience)).toBeNull();
    expect(store.authorize(session?.token, audience)).toBe(true);
    expect(store.authorize(session?.token, { sandboxId: 'sb-1', port: 3001 })).toBe(false);
    expect(store.authorize(session?.token, { sandboxId: 'sb-2', port: 3000 })).toBe(false);
  });

  it('consumes a code presented for the wrong audience', () => {
    const store = new PreviewGrantStore();
    const audience = { sandboxId: 'sb-1', port: 3000 };
    const { code } = store.mint(audience);

    expect(store.exchange(code, { sandboxId: 'sb-2', port: 3000 })).toBeNull();
    expect(store.exchange(code, audience)).toBeNull();
  });

  it('rejects expired codes and sessions', () => {
    let now = 1_000;
    const store = new PreviewGrantStore({ now: () => now, ttlMs: 50 });
    const audience = { sandboxId: 'sb-1', port: 3000 };
    const first = store.mint(audience);
    now += 51;
    expect(store.exchange(first.code, audience)).toBeNull();

    const second = store.mint(audience);
    const session = store.exchange(second.code, audience);
    expect(session).not.toBeNull();
    now += 51;
    expect(store.authorize(session?.token, audience)).toBe(false);
  });
});
