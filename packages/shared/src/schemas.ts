import { z } from 'zod';
import { LIMITS } from './constants';

const b64 = z.string().regex(/^[A-Za-z0-9_-]*$/, 'base64url');
const hex32 = z.string().regex(/^0x[0-9a-f]{64}$/, 'bytes32 hex');
const cid = z.string().regex(/^[a-z0-9]{40,120}$/, 'cid');

export const RatchetHeaderSchema = z.object({
  dh: b64.min(1).max(64),
  pn: z.number().int().min(0).max(2 ** 31),
  n: z.number().int().min(0).max(2 ** 31),
});

export const KeyBundleSchema = z.object({
  v: z.literal(1),
  userId: hex32,
  identityKeyEd25519: b64.length(43), // 32 bytes
  signedPrekeyX25519: b64.length(43),
  signedPrekeySig: b64.length(86), // 64 bytes
  createdAt: z.number().int().nonnegative(),
});

export const BlobEnvelopeSchema = z.object({
  v: z.literal(1),
  header: RatchetHeaderSchema,
  nonce: b64.length(16), // 12 bytes
  ciphertext: b64.min(22), // >= 16-byte tag
});

export const PointerPayloadSchema = z.object({
  cid,
  salt: b64.length(43),
  sig: z.union([z.literal(''), b64.length(86)]),
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
});

export const RelayEnvelopeSchema = z.object({
  inboxId: hex32,
  header: RatchetHeaderSchema,
  nonce: b64.length(16),
  sealedPointer: b64.min(22).max(LIMITS.ENVELOPE_MAX_BYTES),
  x3dh: z.object({ ikA: b64.length(43), ek: b64.length(43), spkUsed: b64.length(43) }).optional(),
});

export const ProofPackageSchema = z.object({
  cid,
  salt: b64.length(43),
  sig: b64.length(86),
  seq: z.number().int().nonnegative(),
  senderUserId: hex32,
  convoId: hex32,
  batchId: z.number().int().nonnegative(),
  proof: z.array(hex32).max(40),
  root: hex32,
  txHash: hex32,
});

export const LeafRequestSchema = z.object({
  commitment: hex32,
  sig: b64.length(86),
  senderUserId: hex32,
  convoId: hex32,
  seq: z.number().int().nonnegative(),
});

export const InboxRegisterSchema = z.object({
  inboxId: hex32,
  inboxPub: b64.length(43),
  kind: z.enum(['random', 'first']),
});

export const ProofResponseSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({
    status: z.literal('anchored'),
    batchId: z.number().int().nonnegative(),
    root: hex32,
    proof: z.array(hex32),
    txHash: hex32,
    anchoredAt: z.number().int().nonnegative(),
  }),
]);

export type LeafRequest = z.infer<typeof LeafRequestSchema>;
export type InboxRegister = z.infer<typeof InboxRegisterSchema>;
export type ProofResponse = z.infer<typeof ProofResponseSchema>;
