import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { accounts, type AccountRow, type NewAccountRow } from '../db/schema.js';

export type { AccountRow };

export function insertAccount(db: Db, values: NewAccountRow): AccountRow {
  db.insert(accounts).values(values).run();
  const row = db.select().from(accounts).where(eq(accounts.id, values.id)).get();
  if (!row) throw new Error('insertAccount: row not found after insert');
  return row;
}

export function findAccountById(db: Db, id: string): AccountRow | undefined {
  return db.select().from(accounts).where(eq(accounts.id, id)).get();
}

export function findAccountByLabel(db: Db, label: string): AccountRow | undefined {
  return db.select().from(accounts).where(eq(accounts.label, label)).get();
}

export function listAccounts(db: Db): AccountRow[] {
  return db.select().from(accounts).all();
}

/** Store api_key ciphertext on an account. */
export function updateAccountKey(db: Db, id: string, encryptedKey: string): void {
  db.update(accounts).set({ encryptedKey }).where(eq(accounts.id, id)).run();
}

/** Store subscription credential-blob ciphertext on an account. */
export function updateAccountCredentials(db: Db, id: string, encryptedCredentials: string): void {
  db.update(accounts).set({ encryptedCredentials }).where(eq(accounts.id, id)).run();
}

export function deleteAccount(db: Db, id: string): void {
  db.delete(accounts).where(eq(accounts.id, id)).run();
}
