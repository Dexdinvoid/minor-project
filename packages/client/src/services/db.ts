import Dexie, { type Table } from 'dexie';
import type { B64, Hex, KeyBundle, MessageStatus, VerifyOutcome } from '@sc/shared';
import type { WrappedSecret } from '@sc/crypto';

export interface IdentityRow {
  id: 'me';
  name: string;
  userId: Hex;
  bundle: KeyBundle;
  wrapped: WrappedSecret; // Argon2id-wrapped {ed, spk, wallet, storage}. The only long-term secret at rest.
}

export interface ContactRow {
  userId: Hex;
  name: string;
  bundle: KeyBundle | null; // null until we resolve it (e.g. someone wrote to us first)
  addedAt: number;
}

export interface SessionRow {
  convoId: Hex;
  peerUserId: Hex;
  myInboxId: Hex;
  peerInboxId: Hex | null;
  /** AEAD(storageKey-derived): JSON {ratchet, inboxPriv}. Ratchet state never touches disk in plaintext. */
  enc: { nonce: B64; ct: B64 };
  /** X3DH header, attached to outgoing messages until the first inbound message arrives. */
  pendingX3dh: { ikA: B64; ek: B64; spkUsed: B64 } | null;
  verifiable: boolean;
  nextSeq: number;
  createdAt: number;
}

export interface MessageRow {
  id?: number;
  convoId: Hex;
  direction: 'in' | 'out';
  text: string;
  ts: number;
  status: MessageStatus;
  seq: number;
  cid: string;
  salt: B64;
  sig: B64;
  senderUserId: Hex;
  leaf?: Hex;
  anchor?: { batchId: number; proof: Hex[]; root: Hex; txHash: Hex };
  outcome?: VerifyOutcome;
  error?: string;
}

class AppDb extends Dexie {
  identity!: Table<IdentityRow, string>;
  contacts!: Table<ContactRow, string>;
  sessions!: Table<SessionRow, string>;
  messages!: Table<MessageRow, number>;
  constructor() {
    super('sc-chat');
    this.version(1).stores({
      identity: 'id',
      contacts: 'userId',
      sessions: 'convoId, myInboxId',
      messages: '++id, convoId, [convoId+ts]',
    });
  }
}

export const appDb = new AppDb();
