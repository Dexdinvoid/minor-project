import { TAGS, concat, fromHex, utf8, type Hex } from '@sc/shared';
import { keccak256 } from './hash';
import { sodium } from './sodium';

/** WebSocket challenge-response: Sign(SC1-INBOX-AUTH, nonce, inboxId). */
export const inboxChallengeMessage = (nonce: Uint8Array, inboxId: Hex): Uint8Array =>
  concat(utf8(TAGS.INBOX_AUTH), nonce, fromHex(inboxId));

/** REST fallback: Sign(SC1-INBOX-AUTH, method, path, timestamp, bodyHash). */
export const inboxRestMessage = (method: string, path: string, timestamp: number, body: Uint8Array): Uint8Array =>
  concat(utf8(TAGS.INBOX_AUTH), utf8(`${method.toUpperCase()}\n${path}\n${timestamp}\n`), keccak256(body));

export const signInbox = (inboxPrivateKey: Uint8Array, message: Uint8Array): Uint8Array =>
  sodium().crypto_sign_detached(message, inboxPrivateKey);

export function verifyInbox(inboxPub: Uint8Array, sig: Uint8Array, message: Uint8Array): boolean {
  try {
    return sodium().crypto_sign_verify_detached(sig, message, inboxPub);
  } catch {
    return false;
  }
}
