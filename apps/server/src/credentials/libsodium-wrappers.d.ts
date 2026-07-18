// Type surface for the libsodium-wrappers CJS build (loaded via createRequire in
// crypto.ts). The package's own type defs aren't reachable under NodeNext ESM
// resolution, and its ESM entry is broken, so we declare only the sealed-box
// surface we use. Kept inside credentials/ because this module is the sole
// libsodium user.
export interface Sodium {
  ready: Promise<void>;
  base64_variants: { ORIGINAL: number };
  from_string(s: string): Uint8Array;
  to_string(bytes: Uint8Array): string;
  from_base64(s: string, variant?: number): Uint8Array;
  to_base64(bytes: Uint8Array, variant?: number): string;
  crypto_box_seed_keypair(seed: Uint8Array): {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    keyType: string;
  };
  crypto_box_seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
  crypto_box_seal_open(
    ciphertext: Uint8Array,
    publicKey: Uint8Array,
    privateKey: Uint8Array,
  ): Uint8Array;
}
