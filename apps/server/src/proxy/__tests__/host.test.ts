import { describe, expect, it } from 'vitest';
import { parsePreviewHost } from '../host.js';

const DOMAIN = 'sandbox.outpost.dev';

describe('parsePreviewHost', () => {
  const cases: Array<[string, string, ReturnType<typeof parsePreviewHost>]> = [
    ['my-sandbox-3000.sandbox.outpost.dev', DOMAIN, { name: 'my-sandbox', port: 3000 }],
    ['my-cool-box-8080.sandbox.outpost.dev', DOMAIN, { name: 'my-cool-box', port: 8080 }],
    // Host header with :port suffix stripped first.
    ['my-sandbox-3000.sandbox.outpost.dev:443', DOMAIN, { name: 'my-sandbox', port: 3000 }],
    // Malformed authority suffixes are rejected rather than truncated.
    ['my-sandbox-3000.sandbox.outpost.dev:evil', DOMAIN, null],
    ['my-sandbox-3000.sandbox.outpost.dev:99999', DOMAIN, null],
    ['my-sandbox-3000.sandbox.outpost.dev:443:evil', DOMAIN, null],
    // Case-insensitive.
    ['MY-Sandbox-3000.Sandbox.Outpost.Dev', DOMAIN, { name: 'my-sandbox', port: 3000 }],
    // Wrong domain.
    ['my-sandbox-3000.other.dev', DOMAIN, null],
    // Spoofed suffix (endsWith would match a naive impl).
    ['evil-sandbox-3000.sandbox.outpost.dev.attacker.com', DOMAIN, null],
    // Bad label start char.
    ['9bad-3000.sandbox.outpost.dev', DOMAIN, null],
    // Port below range.
    ['my-box-0.sandbox.outpost.dev', DOMAIN, null],
    // Port above range.
    ['my-box-99999.sandbox.outpost.dev', DOMAIN, null],
    // Bare domain (no label).
    ['sandbox.outpost.dev', DOMAIN, null],
    // Wildcard attempt.
    ['*.sandbox.outpost.dev', DOMAIN, null],
    // No numeric port segment.
    ['my-sandbox.sandbox.outpost.dev', DOMAIN, null],
    // Deeper subdomain than a single label.
    ['a.my-box-3000.sandbox.outpost.dev', DOMAIN, null],
  ];

  it.each(cases)('parses %s', (host, domain, expected) => {
    expect(parsePreviewHost(host, domain)).toEqual(expected);
  });

  it('returns null for empty inputs', () => {
    expect(parsePreviewHost('', DOMAIN)).toBeNull();
    expect(parsePreviewHost('x-3000.sandbox.outpost.dev', '')).toBeNull();
  });
});
