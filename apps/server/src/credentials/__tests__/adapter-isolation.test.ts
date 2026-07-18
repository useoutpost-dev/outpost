import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

// Enforce the architecture boundary: ONLY files under
// apps/server/src/credentials/ or apps/server/src/telemetry/ may import
// @outpost/claude-adapters. Any other server module reaching for Claude Code
// internals is a rejection. (telemetry/ was added in phase 5.)
const serverSrc = path.resolve(fileURLToPath(import.meta.url), '../../../');
const credentialsDir = path.join(serverSrc, 'credentials');
const telemetryDir = path.join(serverSrc, 'telemetry');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('adapter isolation', () => {
  it('no file outside credentials/ imports @outpost/claude-adapters', () => {
    const offenders: string[] = [];
    for (const file of walk(serverSrc)) {
      if (file.startsWith(credentialsDir + path.sep)) continue;
      if (file.startsWith(telemetryDir + path.sep)) continue;
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('@outpost/claude-adapters')) {
        offenders.push(path.relative(serverSrc, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});
