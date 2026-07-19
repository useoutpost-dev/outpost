import { describe, expect, it } from 'vitest';
import type { EventRecord } from '@outpost/shared-api';
import { eventText } from './ActivityFeed';

function record(payload: unknown): EventRecord {
  return { id: 1, ts: 0, kind: 'port.exposed', sandboxId: 'sbx-1', payload };
}

describe('ActivityFeed eventText', () => {
  it('reads object and JSON-string payloads', () => {
    expect(eventText(record({ port: 3000 }))).toBe('sbx-1 port 3000 exposed');
    expect(eventText(record('{"port":8080}'))).toBe('sbx-1 port 8080 exposed');
  });

  it('falls back to the raw event kind for invalid JSON', () => {
    expect(eventText(record('{invalid'))).toBe('port.exposed');
  });
});
