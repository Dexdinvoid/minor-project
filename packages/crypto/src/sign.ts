import { TAGS, concat, fromHex, uint64be, utf8, type Hex } from '@sc/shared';
import { sodium } from './sodium';

/** msg = "SC1-SIG" ++ C ++ senderUserId ++ convoId ++ uint64be(seq) */
export function signatureMessage(C: Uint8Array, senderUserId: Hex, convoId: Hex, seq: number | bigint): Uint8Array {
  return concat(utf8(TAGS.SIG), C, fromHex(senderUserId), fromHex(convoId), uint64be(seq));
}

export function signCommitment(
  edPrivateKey: Uint8Array, C: Uint8Array, senderUserId: Hex, convoId: Hex, seq: number | bigint,
): Uint8Array {
  return sodium().crypto_sign_detached(signatureMessage(C, senderUserId, convoId, seq), edPrivateKey);
}

export function verifyCommitmentSig(
  edPublicKey: Uint8Array, sig: Uint8Array, C: Uint8Array, senderUserId: Hex, convoId: Hex, seq: number | bigint,
): boolean {
  try {
    return sodium().crypto_sign_verify_detached(sig, signatureMessage(C, senderUserId, convoId, seq), edPublicKey);
  } catch {
    return false;
  }
}
