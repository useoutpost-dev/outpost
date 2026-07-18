import crypto from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { OutpostError } from '@outpost/shared-api';
import type { SandboxProvider } from '@outpost/shared-api';
import {
  CLAUDE_CREDENTIALS_ENV,
  CLAUDE_CREDENTIALS_PATH,
  encodeCredentialsForEnv,
  validateCredentialsBlob,
} from '@outpost/claude-adapters';
import type { Db } from '../db/client.js';
import { events, sandboxes } from '../db/schema.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import {
  insertAccount,
  findAccountById,
  findAccountByLabel,
  listAccounts,
  updateAccountCredentials,
  deleteAccount,
  type AccountRow,
} from './accounts.repo.js';

export type AccountKind = 'subscription' | 'api_key';

/** Public shape — NEVER carries ciphertext or plaintext secret material. */
export interface AccountPublic {
  id: string;
  label: string;
  kind: AccountKind;
  hasCredentials: boolean;
  createdAt: string;
}

export interface CreateAccountInput {
  label: string;
  kind: AccountKind;
  /** Required iff kind === 'api_key'. */
  apiKey?: string;
}

/** Minimal sandbox row shape captureFromSandbox needs (avoids repo coupling). */
export interface SandboxRefForCapture {
  accountId: string | null;
  providerRef: string | null;
  status: string;
}

export interface CredentialsServiceDeps {
  db: Db;
  provider: SandboxProvider;
}

function hasCredentials(row: AccountRow): boolean {
  if (row.kind === 'api_key') return row.encryptedKey != null;
  return row.encryptedCredentials != null;
}

function toPublic(row: AccountRow): AccountPublic {
  return {
    id: row.id,
    label: row.label,
    kind: row.kind,
    hasCredentials: hasCredentials(row),
    createdAt: row.createdAt.toISOString(),
  };
}

/** Emit an account event. Payload is label + kind ONLY — never secrets/ids of keys. */
function appendAccountEvent(db: Db, kind: string, payload: { label: string; kind: AccountKind }): void {
  db.insert(events).values({ kind, sandboxId: null, payload }).run();
}

export function createCredentialsService(deps: CredentialsServiceDeps) {
  const { db, provider } = deps;

  async function createAccount(input: CreateAccountInput): Promise<AccountPublic> {
    const { label, kind, apiKey } = input;

    if (findAccountByLabel(db, label)) {
      throw new OutpostError('CONFLICT', 409, 'account label already exists');
    }

    if (kind === 'api_key') {
      if (!apiKey || apiKey.length === 0) {
        throw new OutpostError('BAD_REQUEST', 400, 'apiKey is required for api_key accounts');
      }
    } else if (apiKey) {
      throw new OutpostError('BAD_REQUEST', 400, 'apiKey must not be set for subscription accounts');
    }

    const id = crypto.randomUUID();
    // Encrypt BEFORE the insert so no plaintext ever reaches the DB layer.
    const encryptedKey = kind === 'api_key' ? await encryptSecret(apiKey!) : null;

    const row = insertAccount(db, {
      id,
      label,
      kind,
      credentialVolumeRef: null,
      encryptedKey,
      encryptedCredentials: null,
    });

    appendAccountEvent(db, 'account.created', { label, kind });
    return toPublic(row);
  }

  function list(): AccountPublic[] {
    return listAccounts(db).map(toPublic);
  }

  function get(id: string): AccountPublic {
    const row = findAccountById(db, id);
    if (!row) throw new OutpostError('NOT_FOUND', 404, 'account not found');
    return toPublic(row);
  }

  function remove(id: string): void {
    const row = findAccountById(db, id);
    if (!row) throw new OutpostError('NOT_FOUND', 404, 'account not found');

    // Refuse to delete while any non-destroyed sandbox still references it.
    const refs = db
      .select({ id: sandboxes.id })
      .from(sandboxes)
      .where(and(eq(sandboxes.accountId, id), ne(sandboxes.status, 'destroyed')))
      .all();
    if (refs.length > 0) {
      throw new OutpostError('CONFLICT', 409, 'account is in use by one or more sandboxes');
    }

    deleteAccount(db, id);
    appendAccountEvent(db, 'account.removed', { label: row.label, kind: row.kind });
  }

  /**
   * Assemble the credential env vars to inject into a sandbox for an account.
   * Secrets are decrypted here at inject time only. Never logged.
   */
  async function envForAccount(accountId: string): Promise<Record<string, string>> {
    const row = findAccountById(db, accountId);
    if (!row) throw new OutpostError('NOT_FOUND', 404, 'account not found');

    if (row.kind === 'api_key') {
      if (!row.encryptedKey) {
        throw new OutpostError('INTERNAL', 500, 'api_key account has no stored key');
      }
      const apiKey = await decryptSecret(row.encryptedKey);
      return { ANTHROPIC_API_KEY: apiKey };
    }

    // subscription: inject captured creds if we have them; otherwise login
    // happens in-sandbox on first use.
    if (!row.encryptedCredentials) return {};
    const blob = await decryptSecret(row.encryptedCredentials);
    return { [CLAUDE_CREDENTIALS_ENV]: encodeCredentialsForEnv(blob) };
  }

  /**
   * Best-effort capture of a subscription account's Claude credential file from
   * a running sandbox. Returns true iff a valid blob was captured and stored.
   * Never throws; never logs stdout.
   */
  async function captureFromSandbox(sandboxRow: SandboxRefForCapture): Promise<boolean> {
    if (!sandboxRow.accountId || !sandboxRow.providerRef) return false;
    if (sandboxRow.status !== 'running') return false;

    const account = findAccountById(db, sandboxRow.accountId);
    if (!account || account.kind !== 'subscription') return false;

    let result: { exitCode: number; stdout: string };
    try {
      result = await provider.exec(sandboxRow.providerRef, ['cat', CLAUDE_CREDENTIALS_PATH]);
    } catch {
      return false;
    }

    if (result.exitCode !== 0) return false;
    if (!validateCredentialsBlob(result.stdout)) return false;

    try {
      const ciphertext = await encryptSecret(result.stdout);
      updateAccountCredentials(db, account.id, ciphertext);
    } catch {
      return false;
    }
    return true;
  }

  return { createAccount, list, get, remove, envForAccount, captureFromSandbox };
}

export type CredentialsService = ReturnType<typeof createCredentialsService>;
