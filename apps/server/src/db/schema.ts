import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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
