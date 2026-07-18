import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalize } from '../normalize.js';
import type { UsageInsert } from '../../db/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf-8'));

const ALLOWED_KEYS = [
  'accountId',
  'cacheReadTokens',
  'cacheWriteTokens',
  'estCostUsd',
  'inputTokens',
  'model',
  'outputTokens',
  'sandboxId',
].sort();

function byKey(rows: UsageInsert[]) {
  const m = new Map<string, UsageInsert>();
  for (const r of rows) m.set(`${r.sandboxId} ${r.model}`, r);
  return m;
}

describe('normalize', () => {
  it('collapses a valid OTLP batch to one row per (sandbox, model)', () => {
    const rows = normalize(readFixture('otlp-valid.json'));
    expect(rows).toHaveLength(3);

    const m = byKey(rows);

    const alphaSonnet = m.get('sbx-alpha claude-sonnet-4')!;
    expect(alphaSonnet.accountId).toBe('acc-1');
    expect(alphaSonnet.inputTokens).toBe(150);
    expect(alphaSonnet.outputTokens).toBe(20);
    expect(alphaSonnet.cacheReadTokens).toBe(9);
    expect(alphaSonnet.cacheWriteTokens).toBe(3);
    expect(alphaSonnet.estCostUsd).toBeCloseTo(0.02, 10);

    const alphaHaiku = m.get('sbx-alpha claude-haiku-4')!;
    expect(alphaHaiku.accountId).toBe('acc-1');
    expect(alphaHaiku.inputTokens).toBe(7);
    expect(alphaHaiku.outputTokens).toBe(0);

    const beta = m.get('sbx-beta claude-sonnet-4')!;
    expect(beta.accountId).toBeNull();
    expect(beta.outputTokens).toBe(42);
  });

  it('emits exactly the allowed field set and nothing else', () => {
    const rows = normalize(readFixture('otlp-valid.json'));
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(ALLOWED_KEYS);
    }
  });

  it('returns [] for a malformed payload', () => {
    expect(normalize(readFixture('otlp-malformed.json'))).toEqual([]);
  });

  it('returns [] for non-object / junk input without throwing', () => {
    expect(normalize(null)).toEqual([]);
    expect(normalize(undefined)).toEqual([]);
    expect(normalize('string')).toEqual([]);
    expect(normalize(42)).toEqual([]);
    expect(normalize([])).toEqual([]);
    expect(normalize({})).toEqual([]);
  });

  it('never references prompt or content fields in source', () => {
    const src = readFileSync(path.join(here, '..', 'normalize.ts'), 'utf-8');
    expect(/prompt/i.test(src)).toBe(false);
    expect(/content/i.test(src)).toBe(false);
  });
});
