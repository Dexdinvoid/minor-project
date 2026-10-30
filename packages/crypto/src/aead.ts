import { AuthError, randomBytes, sodium } from './sodium';

export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;

/** ChaCha20-Poly1305 IETF with a FRESH random 12-byte nonce per call (pitfall C5). */
export function aeadEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  ad: Uint8Array,
): { nonce: Uint8Array; ciphertext: Uint8Array } {
  if (key.length !== KEY_BYTES) throw new Error('bad key length');
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = sodium().crypto_aead_chacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, key);
  return { nonce, ciphertext };
}

/** Throws AuthError on ANY failure. Callers must not advance state before this returns. */
export function aeadDecrypt(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  ad: Uint8Array,
): Uint8Array {
  if (key.length !== KEY_BYTES || nonce.length !== NONCE_BYTES || ciphertext.length < 16) {
    throw new AuthError('malformed AEAD input');
  }
  try {
    return sodium().crypto_aead_chacha20poly1305_ietf_decrypt(null, ciphertext, ad, nonce, key);
  } catch {
    throw new AuthError();
  }
}
