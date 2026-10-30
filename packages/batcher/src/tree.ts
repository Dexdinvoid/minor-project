import { MerkleTree } from 'merkletreejs';
import { keccak256 } from '@sc/crypto';
import { fromHex, toHex, type Hex } from '@sc/shared';

const hash = (d: Buffer): Buffer => Buffer.from(keccak256(d));

/**
 * Must match OpenZeppelin MerkleProof (pitfalls M1, M3): leaves are ALREADY hashed, pairs are sorted.
 * packages/crypto/merkle.ts is an independent implementation; tree.test.ts cross-checks both.
 */
export function buildTree(leaves: Hex[]): { root: Hex; proofs: Map<Hex, Hex[]> } {
  if (leaves.length === 0) throw new Error('empty batch');
  const bufs = leaves.map((l) => Buffer.from(fromHex(l)));
  const tree = new MerkleTree(bufs, hash, { hashLeaves: false, sortPairs: true, sortLeaves: true });
  const proofs = new Map<Hex, Hex[]>();
  for (const [i, l] of leaves.entries()) proofs.set(l, tree.getHexProof(bufs[i]!) as Hex[]);
  return { root: toHex(tree.getRoot()), proofs };
}
