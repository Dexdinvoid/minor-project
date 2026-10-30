import { beforeAll, describe, expect, it } from 'vitest';
import { bytesEqual, fromHex, toHex, utf8 } from '@sc/shared';
import {
  commitment, convoIdOf, generateIdentity, initCrypto, keccak256, leafOf, merkleProof, merkleRoot,
  signCommitment, sortLeaves, verifyCommitmentSig, verifyMerkleProof, randomBytes,
} from '../src';

beforeAll(initCrypto);

const leaves = (n: number) => Array.from({ length: n }, (_, i) => keccak256(utf8(`leaf-${i}`)));

describe('commitment, signature, leaf', () => {
  it('C depends on both cid and salt', () => {
    const salt = randomBytes(32);
    expect(bytesEqual(commitment('cidA', salt), commitment('cidB', salt))).toBe(false);
    expect(bytesEqual(commitment('cidA', salt), commitment('cidA', randomBytes(32)))).toBe(false);
  });

  it('signature verifies; any field change breaks it', () => {
    const alice = generateIdentity();
    const bob = generateIdentity();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    const C = commitment('cid', randomBytes(32));
    const sig = signCommitment(alice.ed.privateKey, C, alice.bundle.userId, convo, 7);
    const ok = (c = C, s = alice.bundle.userId, cv = convo, q = 7, pk = alice.ed.publicKey) =>
      verifyCommitmentSig(pk, sig, c, s, cv, q);
    expect(ok()).toBe(true);
    expect(ok(commitment('cid2', randomBytes(32)))).toBe(false);
    expect(ok(C, bob.bundle.userId)).toBe(false);
    expect(ok(C, alice.bundle.userId, '0x' + '00'.repeat(32))).toBe(false);
    expect(ok(C, alice.bundle.userId, convo, 8)).toBe(false);
    expect(ok(C, alice.bundle.userId, convo, 7, bob.ed.publicKey)).toBe(false);
  });

  it('seq above 2^32 signs correctly (pitfall C4)', () => {
    const a = generateIdentity();
    const convo = '0x' + '22'.repeat(32);
    const C = commitment('c', randomBytes(32));
    const sig = signCommitment(a.ed.privateKey, C, a.bundle.userId, convo, 2 ** 40);
    expect(verifyCommitmentSig(a.ed.publicKey, sig, C, a.bundle.userId, convo, 2 ** 40)).toBe(true);
    expect(verifyCommitmentSig(a.ed.publicKey, sig, C, a.bundle.userId, convo, 2 ** 40 + 1)).toBe(false);
  });

  it('leaf is domain separated: it differs from a bare hash of C||keccak(sig)', () => {
    const C = randomBytes(32);
    const sig = randomBytes(64);
    const bare = keccak256(new Uint8Array([...C, ...keccak256(sig)]));
    expect(bytesEqual(leafOf(C, sig), bare)).toBe(false);
    expect(leafOf(C, sig)).toHaveLength(32);
  });
});

describe('Merkle (sorted pairs, OZ compatible)', () => {
  it.each([1, 2, 3, 4, 5, 7, 8, 9, 63, 64, 65, 100])('every leaf proves for size %i (pitfall M4)', (n) => {
    const ls = sortLeaves(leaves(n));
    const root = merkleRoot(ls);
    for (let i = 0; i < n; i++) {
      expect(verifyMerkleProof(ls[i]!, merkleProof(ls, i), root)).toBe(true);
    }
  });

  it('tampered leaf, tampered proof, wrong root all fail', () => {
    const ls = sortLeaves(leaves(9));
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 3);
    expect(verifyMerkleProof(keccak256(utf8('evil')), proof, root)).toBe(false);
    const bad = proof.map((p) => p.slice());
    bad[0]![0] = bad[0]![0]! ^ 1;
    expect(verifyMerkleProof(ls[3]!, bad, root)).toBe(false);
    expect(verifyMerkleProof(ls[3]!, proof, keccak256(utf8('other root')))).toBe(false);
  });

  it('a single-leaf tree has root == leaf and an empty proof', () => {
    const [l] = leaves(1);
    expect(toHex(merkleRoot([l!]))).toBe(toHex(l!));
    expect(merkleProof([l!], 0)).toHaveLength(0);
  });

  it('proofs are position independent: sibling order does not matter (sorted pairs)', () => {
    const ls = leaves(6); // deliberately unsorted input is still a valid tree for these functions
    const root = merkleRoot(ls);
    expect(verifyMerkleProof(ls[2]!, merkleProof(ls, 2), root)).toBe(true);
    expect(fromHex(toHex(root))).toHaveLength(32);
  });
});
