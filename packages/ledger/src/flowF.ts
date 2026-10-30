import {
  bytesEqual, fromB64, fromHex, toHex,
  type B64, type Hex, type KeyBundle, type VerifyOutcome,
} from '@sc/shared';
import { bundleHash, commitment, leafOf, verifyBundle, verifyCommitmentSig, verifyMerkleProof } from '@sc/crypto';

/** Everything Flow F needs from the outside world. Injected so it runs in the browser, the auditor CLI and tests. */
export interface FlowFDeps {
  /** Sender bundle plus the hash the KeyRegistry holds for it, or null if unregistered. */
  resolveBundle(userId: Hex): Promise<{ bundle: KeyBundle; onChainHash: Hex } | null>;
  /** On-chain batch (AnchorRegistry.batches), or null if the batch id does not exist. */
  getBatch(batchId: number): Promise<{ root: Hex; anchoredAt: number } | null>;
  /** Raw bytes of the blob for a CID, already hash-verified by the IPFS adapter (throws if missing or altered). */
  fetchBlob(cid: string): Promise<Uint8Array>;
}

export interface FlowFInput {
  cid: string;
  salt: B64;
  sig: B64;
  seq: number;
  senderUserId: Hex;
  convoId: Hex;
  /** Absent while the batcher has not anchored the leaf yet. */
  anchor?: { batchId: number; proof: Hex[]; root: Hex; txHash: Hex };
}

export type StepStatus = 'pass' | 'fail' | 'skipped';
export interface FlowFStep {
  id: 'bundle' | 'signature' | 'anchor' | 'merkle' | 'content';
  label: string;
  status: StepStatus;
  detail?: string;
}

export interface FlowFResult {
  outcome: VerifyOutcome;
  steps: FlowFStep[];
  anchoredAt?: number;
  leaf?: Hex;
}

const LABELS: Record<FlowFStep['id'], string> = {
  bundle: 'Sender key matches the on-chain registry',
  signature: 'Sender signed this commitment',
  anchor: 'Commitment is anchored in a batch',
  merkle: 'Merkle proof reaches the on-chain root',
  content: 'Stored content still matches its CID',
};

/**
 * SYSTEM_DESIGN.md section 8. Returns the FIRST failing outcome and marks later steps skipped.
 * The UI must display only this result (pitfall U2).
 */
export async function verifyFlowF(input: FlowFInput, deps: FlowFDeps): Promise<FlowFResult> {
  const steps: FlowFStep[] = (Object.keys(LABELS) as FlowFStep['id'][]).map((id) => ({
    id, label: LABELS[id], status: 'skipped' as StepStatus,
  }));
  const step = (id: FlowFStep['id']) => steps.find((s) => s.id === id)!;
  const done = (outcome: VerifyOutcome, extra: Partial<FlowFResult> = {}): FlowFResult => ({ outcome, steps, ...extra });
  const fail = (id: FlowFStep['id'], detail: string) => {
    step(id).status = 'fail';
    step(id).detail = detail;
  };
  const pass = (id: FlowFStep['id'], detail?: string) => {
    step(id).status = 'pass';
    if (detail) step(id).detail = detail;
  };

  // F3: recompute C = keccak256(cid, salt)
  let C: Uint8Array;
  let sig: Uint8Array;
  try {
    C = commitment(input.cid, fromB64(input.salt));
    sig = fromB64(input.sig);
  } catch {
    fail('bundle', 'malformed proof input');
    return done('INVALID_SIGNATURE');
  }

  // F4: sender bundle: KeyRegistry -> IPFS, hash must equal the on-chain bundleHash
  let senderKey: Uint8Array;
  try {
    const resolved = await deps.resolveBundle(input.senderUserId);
    if (!resolved) {
      fail('bundle', 'sender is not registered in KeyRegistry');
      return done('KEY_MISMATCH');
    }
    if (bundleHash(resolved.bundle) !== resolved.onChainHash.toLowerCase()) {
      fail('bundle', 'bundle hash differs from the on-chain hash');
      return done('KEY_MISMATCH');
    }
    const check = verifyBundle(resolved.bundle);
    if (!check.ok) {
      fail('bundle', `bundle invalid: ${check.reason}`);
      return done('KEY_MISMATCH');
    }
    if (resolved.bundle.userId.toLowerCase() !== input.senderUserId.toLowerCase()) {
      fail('bundle', 'bundle belongs to a different userId');
      return done('KEY_MISMATCH');
    }
    senderKey = fromB64(resolved.bundle.identityKeyEd25519);
    pass('bundle');
  } catch (e) {
    fail('bundle', `could not load sender bundle: ${(e as Error).message}`);
    return done('KEY_MISMATCH');
  }

  // F5: Ed25519.verify(sig, tag, C, senderUserId, convoId, seq)
  if (!verifyCommitmentSig(senderKey, sig, C, input.senderUserId, input.convoId, input.seq)) {
    fail('signature', 'Ed25519 signature does not verify');
    return done('INVALID_SIGNATURE');
  }
  pass('signature');

  // F6: leaf
  const leaf = toHex(leafOf(C, sig));

  // F7: anchored proof available?
  if (!input.anchor) {
    step('anchor').status = 'fail';
    step('anchor').detail = 'not anchored yet: signed, waiting for the next batch';
    return done('PENDING', { leaf });
  }
  pass('anchor', `batch ${input.anchor.batchId}`);

  // F8-F9: on-chain root, then Merkle proof
  let batch: { root: Hex; anchoredAt: number } | null;
  try {
    batch = await deps.getBatch(input.anchor.batchId);
  } catch (e) {
    fail('merkle', `could not read AnchorRegistry: ${(e as Error).message}`);
    return done('INVALID_PROOF', { leaf });
  }
  if (!batch) {
    fail('merkle', 'batch does not exist on chain');
    return done('INVALID_PROOF', { leaf });
  }
  const onChainRoot = fromHex(batch.root);
  const claimedRootOk = bytesEqual(fromHex(input.anchor.root), onChainRoot);
  let proofOk = false;
  try {
    proofOk = verifyMerkleProof(fromHex(leaf), input.anchor.proof.map(fromHex), onChainRoot);
  } catch {
    proofOk = false;
  }
  if (!claimedRootOk || !proofOk) {
    fail('merkle', !claimedRootOk ? 'proof package root differs from the on-chain root' : 'leaf does not reach the on-chain root');
    return done('INVALID_PROOF', { leaf, anchoredAt: batch.anchoredAt });
  }
  pass('merkle');

  // F10-F11: content still matches CID (the adapter recomputes hash(bytes) == cid)
  try {
    await deps.fetchBlob(input.cid);
    pass('content');
  } catch (e) {
    fail('content', `blob missing or altered: ${(e as Error).message}`);
    return done('CONTENT_ALTERED_OR_MISSING', { leaf, anchoredAt: batch.anchoredAt });
  }

  return done('VERIFIED', { leaf, anchoredAt: batch.anchoredAt });
}
