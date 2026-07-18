// Credential encryption at rest — libsodium sealed box (crypto_box_seal).
//
// Master key: read from the `OUTPOST_MASTER_KEY` env var, 32 raw bytes encoded
// base64. It seeds a deterministic X25519 keypair via crypto_box_seed_keypair.
// Secrets are sealed to the public key (anonymous sender) and can only be
// opened with the derived secret key.
//
// OPERATIONAL NOTE (self-hosters, read this):
//   - Key loss = stored secrets unrecoverable. There is no recovery path; if
//     OUTPOST_MASTER_KEY is lost, every stored API key / captured credential
//     blob is permanently undecryptable. Back the key up out-of-band.
//   - Key rotation is OUT OF SCOPE for this phase. Changing the key invalidates
//     all existing ciphertext; there is intentionally no re-encrypt migration.
//
// This is the ONLY module that touches the master key. Errors never echo the
// key material into messages or logs.
import { createRequire } from 'node:module';
import { OutpostError } from '@outpost/shared-api';
import type { Sodium } from './libsodium-wrappers.js';

// The published ESM build of libsodium-wrappers references a sibling
// `./libsodium.mjs` that isn't shipped, so it fails to load under both tsx and
// vitest. The CJS build (dist/modules/libsodium-wrappers.js) is self-contained,
// so we load it via createRequire — the runtime object is identical.
const require = createRequire(import.meta.url);
const _sodium = require('libsodium-wrappers') as Sodium;

const MASTER_KEY_ENV = 'OUTPOST_MASTER_KEY';
const SEED_BYTES = 32;

interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

let cachedKeyPair: KeyPair | null = null;

/**
 * Load and derive the sealed-box keypair from the env master key. Cached after
 * first success. Missing/malformed key -> typed INTERNAL error that never
 * includes the key value.
 */
async function getKeyPair(): Promise<KeyPair> {
  if (cachedKeyPair) return cachedKeyPair;

  await _sodium.ready;
  const sodium = _sodium;

  const raw = process.env[MASTER_KEY_ENV];
  if (!raw || raw.trim().length === 0) {
    throw new OutpostError(
      'INTERNAL',
      500,
      `${MASTER_KEY_ENV} is unset or empty; cannot encrypt/decrypt credentials`,
    );
  }

  let seed: Uint8Array;
  try {
    seed = sodium.from_base64(raw.trim(), sodium.base64_variants.ORIGINAL);
  } catch {
    throw new OutpostError(
      'INTERNAL',
      500,
      `${MASTER_KEY_ENV} is not valid base64; refusing to derive credential key`,
    );
  }

  if (seed.length !== SEED_BYTES) {
    throw new OutpostError(
      'INTERNAL',
      500,
      `${MASTER_KEY_ENV} must decode to ${SEED_BYTES} bytes (got ${seed.length})`,
    );
  }

  let kp: { publicKey: Uint8Array; privateKey: Uint8Array };
  try {
    kp = sodium.crypto_box_seed_keypair(seed);
  } catch {
    throw new OutpostError('INTERNAL', 500, 'failed to derive credential keypair from master key');
  }

  cachedKeyPair = { publicKey: kp.publicKey, privateKey: kp.privateKey };
  return cachedKeyPair;
}

/** Test-only: drop the cached keypair so a changed env key is re-read. */
export function _resetKeyCache(): void {
  cachedKeyPair = null;
}

/** Encrypt a UTF-8 plaintext secret. Returns base64 sealed-box ciphertext. */
export async function encryptSecret(plaintext: string): Promise<string> {
  await _sodium.ready;
  const sodium = _sodium;
  const { publicKey } = await getKeyPair();
  try {
    const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), publicKey);
    return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new OutpostError('INTERNAL', 500, 'failed to encrypt credential');
  }
}

/** Decrypt a base64 sealed-box ciphertext back to its UTF-8 plaintext. */
export async function decryptSecret(ciphertext: string): Promise<string> {
  await _sodium.ready;
  const sodium = _sodium;
  const { publicKey, privateKey } = await getKeyPair();

  let sealed: Uint8Array;
  try {
    sealed = sodium.from_base64(ciphertext, sodium.base64_variants.ORIGINAL);
  } catch {
    throw new OutpostError('INTERNAL', 500, 'stored credential ciphertext is not valid base64');
  }

  let opened: Uint8Array;
  try {
    opened = sodium.crypto_box_seal_open(sealed, publicKey, privateKey);
  } catch {
    throw new OutpostError('INTERNAL', 500, 'failed to decrypt credential (wrong key or corrupt data)');
  }
  return sodium.to_string(opened);
}
