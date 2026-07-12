import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, DB_PATH } from './client.js';

const migrationsFolder = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'drizzle',
);

export function runMigrations(dbPath: string = DB_PATH) {
  const db = createDb(dbPath);
  migrate(db, { migrationsFolder });
  return db;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    runMigrations();
    console.log(`migrations applied to ${DB_PATH}`);
  } catch (err) {
    console.error('migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
