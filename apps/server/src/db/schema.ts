import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const events = sqliteTable('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  kind: text('kind').notNull(),
  sandboxId: text('sandbox_id'),
  payload: text('payload', { mode: 'json' }),
});

export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;

export const sessions = sqliteTable('sessions', {
  // sha256 hex of the cookie token, the raw token never touches the DB
  id: text('id').primaryKey(),
  // immutable GitHub numeric user ID, the allowlist key (usernames can be re-registered)
  githubId: integer('github_id').notNull(),
  // GitHub login kept for display and event payloads only
  githubLogin: text('github_login').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  // display label only — the ONLY account field that may appear in logs/events
  label: text('label').notNull().unique(),
  kind: text('kind', { enum: ['subscription', 'api_key'] }).notNull(),
  // provider volume for the identity layer on multi-attach-capable providers;
  // unused by the Fly path (Fly volumes are single-attach)
  credentialVolumeRef: text('credential_volume_ref'),
  // api_key kind: sealed-box ciphertext of the API key, base64
  encryptedKey: text('encrypted_key'),
  // subscription kind: sealed-box ciphertext of the Claude credential file blob,
  // base64; null until first login has been captured from a sandbox
  encryptedCredentials: text('encrypted_credentials'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;

export const sandboxes = sqliteTable('sandboxes', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  provider: text('provider').notNull(),
  // provider machine id, null until the machine is created
  providerRef: text('provider_ref'),
  // provider volume id, persisted so failed-create cleanup and destroy can find it
  volumeRef: text('volume_ref'),
  // FK to accounts lands in Phase 4
  accountId: text('account_id'),
  status: text('status').notNull(),
  // per-sandbox bearer token for the in-sandbox terminal daemon; null for pre-Phase-3 sandboxes
  terminalToken: text('terminal_token'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type SandboxRow = typeof sandboxes.$inferSelect;
export type NewSandboxRow = typeof sandboxes.$inferInsert;

export const usage = sqliteTable(
  'usage',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    sandboxId: text('sandbox_id').notNull(),
    // nullable — sandboxes created with auth mode "none" have no account
    accountId: text('account_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    // NOTIONAL cost — "est. API value", never real billing
    estCostUsd: real('est_cost_usd').notNull().default(0),
  },
  (t) => ({
    sandboxTsIdx: index('usage_sandbox_ts_idx').on(t.sandboxId, t.ts),
    tsIdx: index('usage_ts_idx').on(t.ts),
  }),
);

export type UsageRow = typeof usage.$inferSelect;
export type UsageInsert = typeof usage.$inferInsert;

export const ports = sqliteTable(
  'ports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sandboxId: text('sandbox_id').notNull(),
    port: integer('port').notNull(),
    // public defaults OFF; flipping it is an explicit, confirmed user action
    public: integer('public', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => ({
    sandboxPortUniq: uniqueIndex('ports_sandbox_port_uniq').on(t.sandboxId, t.port),
  }),
);

export type PortRow = typeof ports.$inferSelect;
export type PortInsert = typeof ports.$inferInsert;
