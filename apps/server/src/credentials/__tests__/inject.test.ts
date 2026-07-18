import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSandboxService } from '../../sandboxes/service.js';
import { createCredentialsService } from '../service.js';
import { _resetKeyCache } from '../crypto.js';
import { events } from '../../db/schema.js';
import { makeTestDb, makeFakeProvider, testSandboxConfig } from '../../__tests__/helpers.js';

const KEY = Buffer.alloc(32, 3).toString('base64');

beforeEach(() => {
  process.env.OUTPOST_MASTER_KEY = KEY;
  _resetKeyCache();
});
afterEach(() => {
  delete process.env.OUTPOST_MASTER_KEY;
});

describe('sandbox create — credential injection', () => {
  it('api_key account: provider spec.env has ANTHROPIC_API_KEY; events never carry the key', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    const credentialsService = createCredentialsService({ db, provider });
    const apiKey = 'sk-ant-inject-me';
    const account = await credentialsService.createAccount({
      label: 'inj',
      kind: 'api_key',
      apiKey,
    });

    let capturedEnv: Record<string, string> | undefined;
    const orig = provider.create.bind(provider);
    vi.spyOn(provider, 'create').mockImplementationOnce(async (spec) => {
      capturedEnv = spec.env;
      return orig(spec);
    });

    const sandboxService = createSandboxService({
      db,
      provider,
      config: testSandboxConfig,
      credentialsService,
    });
    const sbx = await sandboxService.create({ name: 'inj-box', accountId: account.id });

    expect(capturedEnv?.ANTHROPIC_API_KEY).toBe(apiKey);
    // account.id ends up in OTEL resource attrs; the key never does.
    expect(capturedEnv?.OTEL_RESOURCE_ATTRIBUTES).toBe(
      `sandbox.id=${sbx.id},account.id=${account.id}`,
    );

    // No event payload anywhere contains the key material.
    const allEvents = db.select().from(events).all();
    for (const e of allEvents) {
      expect(JSON.stringify(e.payload ?? {})).not.toContain(apiKey);
    }
  });

  it('unknown accountId: create fails 404 without leaving a running sandbox', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    const credentialsService = createCredentialsService({ db, provider });
    const sandboxService = createSandboxService({
      db,
      provider,
      config: testSandboxConfig,
      credentialsService,
    });
    await expect(
      sandboxService.create({ name: 'bad-acct', accountId: 'ghost' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
    expect(sandboxService.list()).toHaveLength(0);
  });

  it('no accountId: env has no ANTHROPIC_API_KEY and plain OTEL attrs', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    let capturedEnv: Record<string, string> | undefined;
    const orig = provider.create.bind(provider);
    vi.spyOn(provider, 'create').mockImplementationOnce(async (spec) => {
      capturedEnv = spec.env;
      return orig(spec);
    });
    const sandboxService = createSandboxService({ db, provider, config: testSandboxConfig });
    const sbx = await sandboxService.create({ name: 'plain-box' });
    expect('ANTHROPIC_API_KEY' in (capturedEnv ?? {})).toBe(false);
    expect(capturedEnv?.OTEL_RESOURCE_ATTRIBUTES).toBe(`sandbox.id=${sbx.id}`);
  });

  it('subscription account: captureFromSandbox runs on stop', async () => {
    const db = makeTestDb();
    const provider = makeFakeProvider();
    const blob = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } });
    provider.exec = async () => ({ exitCode: 0, stdout: blob, stderr: '' });
    const credentialsService = createCredentialsService({ db, provider });
    const captureSpy = vi.spyOn(credentialsService, 'captureFromSandbox');
    const account = await credentialsService.createAccount({ label: 'sub', kind: 'subscription' });

    const sandboxService = createSandboxService({
      db,
      provider,
      config: testSandboxConfig,
      credentialsService,
    });
    const sbx = await sandboxService.create({ name: 'sub-box', accountId: account.id });
    await sandboxService.stop(sbx.id);

    expect(captureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: account.id, status: 'running' }),
    );
  });
});
