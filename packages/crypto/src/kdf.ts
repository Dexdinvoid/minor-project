import { TAGS } from '@sc/shared';
import { hkdfSha256, hmacSha256 } from './hash';

const ONE = new Uint8Array([0x01]);
const TWO = new Uint8Array([0x02]);

/** Root KDF: (rk, dhOut) -> (newRk, chainKey). */
export function kdfRk(rk: Uint8Array, dhOut: Uint8Array): [Uint8Array, Uint8Array] {
  const out = hkdfSha256(dhOut, rk, TAGS.RATCHET_RK, 64);
  return [out.slice(0, 32), out.slice(32, 64)];
}

/** Chain KDF: ck -> (messageKey, nextChainKey) (Signal spec: HMAC with constants 0x01 / 0x02). */
export function kdfCk(ck: Uint8Array): [Uint8Array, Uint8Array] {
  return [hmacSha256(ck, ONE), hmacSha256(ck, TWO)];
}

/** SC1-MSG split: one message key -> encKey (blob) and pointerKey (sealed pointer). */
export function splitMessageKey(mk: Uint8Array): { encKey: Uint8Array; pointerKey: Uint8Array } {
  const out = hkdfSha256(mk, undefined, TAGS.MSG, 64);
  return { encKey: out.slice(0, 32), pointerKey: out.slice(32, 64) };
}

/** Key for at-rest encryption of ratchet state, derived from the vault storage key. */
export function deriveStorageKey(storageKey: Uint8Array, context: string): Uint8Array {
  return hkdfSha256(storageKey, undefined, `${TAGS.STORAGE}:${context}`, 32);
}
