import {
  canonicalBytes, fromB64, fromUtf8, toB64, utf8,
  type BlobEnvelope, type PointerPayload, type RatchetHeader, type RelayEnvelope,
} from '@sc/shared';
import { aeadDecrypt, aeadEncrypt } from './aead';
import { splitMessageKey } from './kdf';
import { ratchetDecryptStep, ratchetEncryptStep, type RatchetState } from './ratchet';
import { AuthError } from './sodium';

const headerAd = (h: RatchetHeader): Uint8Array => canonicalBytes(h);

export interface SealedMessage {
  state: RatchetState;
  header: RatchetHeader;
  blob: BlobEnvelope; // goes to IPFS
  blobBytes: Uint8Array; // canonical JSON bytes of blob (what the client uploads)
  pointerKey: Uint8Array; // seals the pointer in the next step
}

/** Flow C steps 1-3: ratchet step, key split, AEAD(plaintext, ad = header). */
export function sealMessage(prev: RatchetState, plaintext: Uint8Array): SealedMessage {
  const step = ratchetEncryptStep(prev);
  const { encKey, pointerKey } = splitMessageKey(step.messageKey);
  const { nonce, ciphertext } = aeadEncrypt(encKey, plaintext, headerAd(step.header));
  const blob: BlobEnvelope = { v: 1, header: step.header, nonce: toB64(nonce), ciphertext: toB64(ciphertext) };
  return { state: step.state, header: step.header, blob, blobBytes: canonicalBytes(blob), pointerKey };
}

/** Flow C step 9: AEAD(pointerKey, {cid, salt, sig, seq, ts}), bound to the ratchet header. */
export function sealPointer(
  pointerKey: Uint8Array, header: RatchetHeader, payload: PointerPayload,
): { nonce: string; sealedPointer: string } {
  const { nonce, ciphertext } = aeadEncrypt(pointerKey, utf8(JSON.stringify(payload)), headerAd(header));
  return { nonce: toB64(nonce), sealedPointer: toB64(ciphertext) };
}

export interface OpenedEnvelope {
  state: RatchetState; // COMMIT only after the blob also decrypts (Flow D D9 / D14)
  pointer: PointerPayload;
  encKey: Uint8Array;
}

/**
 * Flow D steps 5-8: run the ratchet receive step on a copy, open the sealed pointer.
 * Throws AuthError if the tag is invalid; the caller's stored state is untouched.
 */
export function openEnvelope(prev: RatchetState, env: RelayEnvelope): OpenedEnvelope {
  const step = ratchetDecryptStep(prev, env.header);
  const { encKey, pointerKey } = splitMessageKey(step.messageKey);
  const raw = aeadDecrypt(pointerKey, fromB64(env.nonce), fromB64(env.sealedPointer), headerAd(env.header));
  let pointer: PointerPayload;
  try {
    pointer = JSON.parse(fromUtf8(raw)) as PointerPayload;
  } catch {
    throw new AuthError('pointer payload malformed');
  }
  return { state: step.state, pointer, encKey };
}

/** Flow D step 13. The blob header must equal the envelope header (prevents header swapping). */
export function openBlob(encKey: Uint8Array, blob: BlobEnvelope, expectedHeader: RatchetHeader): Uint8Array {
  const a = fromUtf8(canonicalBytes(blob.header));
  const b = fromUtf8(canonicalBytes(expectedHeader));
  if (a !== b) throw new AuthError('blob header mismatch');
  return aeadDecrypt(encKey, fromB64(blob.nonce), fromB64(blob.ciphertext), headerAd(expectedHeader));
}
