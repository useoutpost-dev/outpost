import { describe, it, expect } from 'vitest';
import { OutpostError } from '../errors.js';

describe('OutpostError', () => {
  it('sets constructor fields correctly', () => {
    const err = new OutpostError('NOT_FOUND', 404, 'resource not found');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.httpStatus).toBe(404);
    expect(err.safeMessage).toBe('resource not found');
    expect(err.message).toBe('resource not found');
    expect(err.name).toBe('OutpostError');
  });

  it('is an instance of Error', () => {
    const err = new OutpostError('INTERNAL', 500, 'internal error');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof OutpostError).toBe(true);
  });

  it('toJSON returns only code and safeMessage', () => {
    const cause = new Error('secret internal cause');
    const err = new OutpostError('PROVIDER_ERROR', 502, 'upstream failed', { cause });
    const json = err.toJSON();
    expect(json).toEqual({ error: { code: 'PROVIDER_ERROR', message: 'upstream failed' } });
    // cause and stack must not appear
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('secret internal cause');
    expect(serialized).not.toContain('stack');
  });

  it('is() type guard returns true for OutpostError', () => {
    const err = new OutpostError('UNAUTHORIZED', 401, 'not authenticated');
    expect(OutpostError.is(err)).toBe(true);
  });

  it('is() type guard returns false for plain Error', () => {
    expect(OutpostError.is(new Error('plain'))).toBe(false);
  });

  it('is() type guard returns false for non-error values', () => {
    expect(OutpostError.is(null)).toBe(false);
    expect(OutpostError.is(undefined)).toBe(false);
    expect(OutpostError.is('string')).toBe(false);
    expect(OutpostError.is(42)).toBe(false);
  });

  it('accepts optional cause without exposing it in toJSON', () => {
    const cause = { secret: 'db credentials' };
    const err = new OutpostError('INTERNAL', 500, 'something went wrong', { cause });
    expect(err.cause).toBe(cause);
    const json = JSON.stringify(err.toJSON());
    expect(json).not.toContain('secret');
    expect(json).not.toContain('db credentials');
  });
});
