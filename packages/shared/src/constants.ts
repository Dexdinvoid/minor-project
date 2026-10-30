/** Domain-separation tags. Import these; never retype them (pitfall C9). */
export const TAGS = {
  X3DH: 'SC1-X3DH',
  MSG: 'SC1-MSG',
  INBOX_AUTH: 'SC1-INBOX-AUTH',
  LEAF: 'SC1-LEAF',
  SIG: 'SC1-SIG',
  FIRST: 'SC1-FIRST',
  // Additional tags (not in the original table; recorded in docs/DECISIONS.md D-003):
  SPK: 'SC1-SPK', // signed-prekey signature (named in KeyBundle comment of the design)
  RATCHET_RK: 'SC1-RATCHET-RK', // root-key KDF
  STORAGE: 'SC1-STORAGE', // at-rest encryption of ratchet state in IndexedDB
} as const;

export const LIMITS = {
  ENVELOPE_MAX_BYTES: 64 * 1024,
  BLOB_MAX_BYTES: 5 * 1024 * 1024,
  /** Client-side cap so a blob is always one IPFS block, making local CID recomputation exact (pitfall S4). */
  CLIENT_BLOB_MAX_BYTES: 256 * 1024,
  PENDING_PER_INBOX: 1000,
  REQ_PER_MIN_PER_IP: 60,
  FAILED_AUTH_PER_MIN_PER_IP: 5,
  MESSAGE_TTL_MS: 7 * 24 * 60 * 60 * 1000,
  CHALLENGE_TTL_MS: 30_000,
  REST_TIMESTAMP_WINDOW_MS: 60_000,
  MAX_SKIP: 1000, // cap on stored skipped message keys (pitfall C8)
  BATCH_MAX_LEAVES: 64,
  BATCH_MAX_AGE_MS: 60_000,
  BATCH_HARD_MAX: 256,
  WS_MAX_INBOXES_PER_SOCKET: 32,
} as const;

export const ZERO_BYTES32 = '0x' + '00'.repeat(32);
