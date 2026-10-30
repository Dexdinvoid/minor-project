import {
  firstInboxId, inboxIdOf, inboxRestMessage, inboxChallengeMessage, keccakHex, userIdOf, verifyInbox,
} from '@sc/crypto';
import { fromB64, fromHex, utf8, type Hex } from '@sc/shared';
import type { InboxRow } from './db';

/** Inbox registration binding: the ID must commit to the key (SYSTEM_DESIGN section 14). */
export function inboxBindingValid(inboxId: Hex, inboxPubB64: string, kind: 'random' | 'first'): boolean {
  try {
    const pub = fromB64(inboxPubB64);
    if (pub.length !== 32) return false;
    return kind === 'random' ? inboxIdOf(pub) === inboxId : firstInboxId(userIdOf(pub)) === inboxId;
  } catch {
    return false;
  }
}

export function verifyChallengeSig(inbox: InboxRow, nonceHex: Hex, sigB64: string): boolean {
  try {
    return verifyInbox(fromB64(inbox.inboxPub), fromB64(sigB64), inboxChallengeMessage(fromHex(nonceHex), inbox.inboxId as Hex));
  } catch {
    return false;
  }
}

export function verifyRestSig(
  inbox: InboxRow, method: string, path: string, timestamp: number, body: Uint8Array, sigB64: string,
): boolean {
  try {
    return verifyInbox(fromB64(inbox.inboxPub), fromB64(sigB64), inboxRestMessage(method, path, timestamp, body));
  } catch {
    return false;
  }
}

export const sigFingerprint = (sigB64: string): string => keccakHex(utf8(sigB64));
