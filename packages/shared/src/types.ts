export type B64 = string; // base64url, no padding
export type Hex = string; // 0x-prefixed lowercase

export interface KeyBundle {
  v: 1;
  userId: Hex; // keccak256(identityKeyEd25519)
  identityKeyEd25519: B64;
  signedPrekeyX25519: B64;
  signedPrekeySig: B64; // Ed25519 over ("SC1-SPK" + signedPrekeyX25519 bytes)
  createdAt: number; // unix ms
}

export interface RatchetHeader {
  dh: B64;
  pn: number;
  n: number;
}

/** What goes to IPFS (JSON bytes). */
export interface BlobEnvelope {
  v: 1;
  header: RatchetHeader;
  nonce: B64; // 12 bytes, ChaCha20-Poly1305 IETF
  ciphertext: B64; // AEAD, associated data = canonical(header)
}

/** Sealed with pointerKey, never public. sig is '' when the conversation is not in verifiable mode. */
export interface PointerPayload {
  cid: string;
  salt: B64; // 32 random bytes
  sig: B64; // Ed25519 (or '' when not verifiable)
  seq: number; // per-conversation counter
  ts: number;
}

export interface RelayEnvelope {
  inboxId: Hex;
  header: RatchetHeader;
  nonce: B64;
  sealedPointer: B64;
  x3dh?: { ikA: B64; ek: B64; spkUsed: B64 }; // first message only
}

export interface ProofPackage {
  cid: string;
  salt: B64;
  sig: B64;
  seq: number;
  senderUserId: Hex;
  convoId: Hex;
  batchId: number;
  proof: Hex[];
  root: Hex;
  txHash: Hex;
}

/** Plaintext application payload that is AEAD-encrypted inside the blob. */
export interface AppPayload {
  t: 'msg';
  text: string;
  /** Sender announces its current random inbox so the peer can switch away from first-contact. */
  inbox?: Hex;
}

/** The six outcomes of Flow F (SYSTEM_DESIGN.md section 8). */
export type VerifyOutcome =
  | 'KEY_MISMATCH'
  | 'INVALID_SIGNATURE'
  | 'PENDING'
  | 'INVALID_PROOF'
  | 'CONTENT_ALTERED_OR_MISSING'
  | 'VERIFIED';

export type MessageStatus =
  | 'Composed'
  | 'Encrypted'
  | 'UploadFailed'
  | 'Uploaded'
  | 'Sent'
  | 'Delivered'
  | 'Submitted'
  | 'Anchored'
  | 'Verified'
  | 'Invalid'
  | 'FetchPending';
