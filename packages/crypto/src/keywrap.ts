import { fromB64, toB64, utf8, type B64 } from '@sc/shared';
import { aeadDecrypt, aeadEncrypt } from './aead';
import { AuthError, randomBytes, sodium } from './sodium';

export interface WrappedSecret {
  v: 1;
  salt: B64;
  ops: number;
  mem: number; // bytes
  nonce: B64;
  ct: B64;
}

export interface KdfParams {
  ops: number;
  mem: number;
}

/**
 * Argon2id passphrase wrapping (libsodium crypto_pwhash).
 * NOTE: crypto_pwhash needs the SUMO build (libsodium-wrappers-sumo). If this throws the
 * "missing" error, install `libsodium-wrappers-sumo (this project already does; see docs/DECISIONS.md D-006).
 */
function pwhash(passphrase: string, salt: Uint8Array, p: KdfParams): Uint8Array {
  const s = sodium();
  if (typeof s.crypto_pwhash !== 'function') {
    throw new Error('crypto_pwhash missing: use libsodium-wrappers-sumo');
  }
  return s.crypto_pwhash(32, passphrase, salt, p.ops, p.mem, s.crypto_pwhash_ALG_ARGON2ID13);
}

export function defaultKdfParams(): KdfParams {
  const s = sodium();
  return { ops: s.crypto_pwhash_OPSLIMIT_INTERACTIVE, mem: s.crypto_pwhash_MEMLIMIT_INTERACTIVE };
}

export function wrapSecret(passphrase: string, secret: Uint8Array, params?: KdfParams): WrappedSecret {
  const p = params ?? defaultKdfParams();
  const salt = randomBytes(16);
  const key = pwhash(passphrase, salt, p);
  const { nonce, ciphertext } = aeadEncrypt(key, secret, utf8('SC1-WRAP'));
  sodium().memzero(key);
  return { v: 1, salt: toB64(salt), ops: p.ops, mem: p.mem, nonce: toB64(nonce), ct: toB64(ciphertext) };
}

/** Throws AuthError on a wrong passphrase or tampering. */
export function unwrapSecret(passphrase: string, w: WrappedSecret): Uint8Array {
  if (w.v !== 1) throw new AuthError('unsupported wrap version');
  const key = pwhash(passphrase, fromB64(w.salt), { ops: w.ops, mem: w.mem });
  try {
    return aeadDecrypt(key, fromB64(w.nonce), fromB64(w.ct), utf8('SC1-WRAP'));
  } finally {
    sodium().memzero(key);
  }
}
