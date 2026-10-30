import { beforeAll, describe, expect, it } from 'vitest';
import { toB64, toHex, type Hex } from '@sc/shared';
import {
  bundleHash, commitment, convoIdOf, generateIdentity, initCrypto, keccak256, leafOf, merkleProof, merkleRoot,
  randomBytes, signCommitment, sortLeaves, type Identity,
} from '@sc/crypto';
import { verifyFlowF, type FlowFDeps, type FlowFInput } from '../src/flowF';

beforeAll(initCrypto);

/** Builds a complete, honest scenario; individual tests then break exactly one thing. */
function scenario(batchSize = 5) {
  const alice: Identity = generateIdentity();
  const bob: Identity = generateIdentity();
  const convoId = convoIdOf(alice.bundle.userId, bob.bundle.userId);
  const cid = 'bafkreiexamplecidexamplecidexamplecidexamplecidexample';
  const salt = randomBytes(32);
  const C = commitment(cid, salt);
  const seq = 3;
  const sig = signCommitment(alice.ed.privateKey, C, alice.bundle.userId, convoId, seq);
  const myLeaf = leafOf(C, sig);
  const others = Array.from({ length: batchSize - 1 }, (_, i) => keccak256(new Uint8Array([i, 9, 9])));
  const sorted = sortLeaves([myLeaf, ...others]);
  const idx = sorted.findIndex((l) => toHex(l) === toHex(myLeaf));
  const root = toHex(merkleRoot(sorted));
  const proof = merkleProof(sorted, idx).map(toHex);
  const blob = new TextEncoder().encode('ciphertext');

  const input: FlowFInput = {
    cid, salt: toB64(salt), sig: toB64(sig), seq, senderUserId: alice.bundle.userId, convoId,
    anchor: { batchId: 0, proof, root, txHash: ('0x' + 'ab'.repeat(32)) as Hex },
  };
  const deps: FlowFDeps = {
    resolveBundle: async () => ({ bundle: alice.bundle, onChainHash: bundleHash(alice.bundle) }),
    getBatch: async (id) => (id === 0 ? { root: root as Hex, anchoredAt: 1_700_000_000 } : null),
    fetchBlob: async () => blob,
  };
  return { alice, bob, input, deps, root };
}

describe('Flow F: all six outcomes', () => {
  it('VERIFIED: honest message', async () => {
    const { input, deps } = scenario();
    const r = await verifyFlowF(input, deps);
    expect(r.outcome).toBe('VERIFIED');
    expect(r.anchoredAt).toBe(1_700_000_000);
    expect(r.steps.map((s) => s.status)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
  });

  it('VERIFIED also for a single-leaf batch (empty proof)', async () => {
    const { input, deps } = scenario(1);
    expect((await verifyFlowF(input, deps)).outcome).toBe('VERIFIED');
  });

  it('PENDING: signed but not yet anchored', async () => {
    const { input, deps } = scenario();
    const r = await verifyFlowF({ ...input, anchor: undefined }, deps);
    expect(r.outcome).toBe('PENDING');
    expect(r.steps.find((s) => s.id === 'signature')!.status).toBe('pass');
    expect(r.steps.find((s) => s.id === 'merkle')!.status).toBe('skipped');
  });

  it('INVALID_SIGNATURE: wrong seq, wrong convo, or a salt that changes the commitment', async () => {
    const { input, deps } = scenario();
    expect((await verifyFlowF({ ...input, seq: input.seq + 1 }, deps)).outcome).toBe('INVALID_SIGNATURE');
    expect((await verifyFlowF({ ...input, convoId: ('0x' + '00'.repeat(32)) as Hex }, deps)).outcome).toBe('INVALID_SIGNATURE');
    expect((await verifyFlowF({ ...input, salt: toB64(randomBytes(32)) }, deps)).outcome).toBe('INVALID_SIGNATURE');
  });

  it('INVALID_SIGNATURE: signature made by somebody else', async () => {
    const { input, deps, bob } = scenario();
    const C = commitment(input.cid, new Uint8Array(32));
    const forged = signCommitment(bob.ed.privateKey, C, input.senderUserId, input.convoId, input.seq);
    expect((await verifyFlowF({ ...input, sig: toB64(forged) }, deps)).outcome).toBe('INVALID_SIGNATURE');
  });

  it('INVALID_PROOF: tampered proof, wrong root claim, or unknown batch', async () => {
    const { input, deps } = scenario(9);
    const badProof = [...input.anchor!.proof];
    badProof[0] = ('0x' + 'cd'.repeat(32)) as Hex;
    expect((await verifyFlowF({ ...input, anchor: { ...input.anchor!, proof: badProof } }, deps)).outcome).toBe('INVALID_PROOF');
    expect((await verifyFlowF({ ...input, anchor: { ...input.anchor!, root: ('0x' + '11'.repeat(32)) as Hex } }, deps)).outcome).toBe('INVALID_PROOF');
    expect((await verifyFlowF({ ...input, anchor: { ...input.anchor!, batchId: 42 } }, deps)).outcome).toBe('INVALID_PROOF');
  });

  it('INVALID_PROOF: a malicious batcher root that is not the on-chain root', async () => {
    const { input, deps } = scenario();
    const evilDeps: FlowFDeps = { ...deps, getBatch: async () => ({ root: ('0x' + '22'.repeat(32)) as Hex, anchoredAt: 1 }) };
    expect((await verifyFlowF(input, evilDeps)).outcome).toBe('INVALID_PROOF');
  });

  it('CONTENT_ALTERED_OR_MISSING: IPFS adapter throws (hash mismatch or not found)', async () => {
    const { input, deps } = scenario();
    const r = await verifyFlowF(input, { ...deps, fetchBlob: async () => { throw new Error('content does not match CID'); } });
    expect(r.outcome).toBe('CONTENT_ALTERED_OR_MISSING');
    expect(r.steps.find((s) => s.id === 'merkle')!.status).toBe('pass');
  });

  it('KEY_MISMATCH: bundle hash differs from the chain, unregistered sender, or userId swap', async () => {
    const { input, deps, bob } = scenario();
    expect((await verifyFlowF(input, { ...deps, resolveBundle: async () => ({ bundle: bob.bundle, onChainHash: bundleHash(bob.bundle) }) })).outcome).toBe('KEY_MISMATCH');
    expect((await verifyFlowF(input, { ...deps, resolveBundle: async () => null })).outcome).toBe('KEY_MISMATCH');
    expect((await verifyFlowF(input, { ...deps, resolveBundle: async () => ({ bundle: scenario().alice.bundle, onChainHash: ('0x' + '00'.repeat(32)) as Hex }) })).outcome).toBe('KEY_MISMATCH');
    expect((await verifyFlowF(input, { ...deps, resolveBundle: async () => { throw new Error('ipfs down'); } })).outcome).toBe('KEY_MISMATCH');
  });
});
