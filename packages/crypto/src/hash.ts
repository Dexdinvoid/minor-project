// All noble imports are isolated here so a module-path change in a future release is a one-file fix.
import { keccak_256 } from '@noble/hashes/sha3.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { toHex, type Hex } from '@sc/shared';

export const keccak256 = (b: Uint8Array): Uint8Array => keccak_256(b);
export const keccakHex = (b: Uint8Array): Hex => toHex(keccak_256(b));
export const sha256Bytes = (b: Uint8Array): Uint8Array => sha256(b);
export const hmacSha256 = (key: Uint8Array, data: Uint8Array): Uint8Array => hmac(sha256, key, data);
export const hkdfSha256 = (
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: string | Uint8Array,
  len: number,
): Uint8Array => hkdf(sha256, ikm, salt, info, len);
