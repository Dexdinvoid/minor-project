import { bytesEqual, concat } from '@sc/shared';
import { keccak256 } from './hash';

function cmp(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return a.length - b.length;
}

/** Sorted-pair hashing, identical to OpenZeppelin MerkleProof (pitfall M1). */
export function hashPair(a: Uint8Array, b: Uint8Array): Uint8Array {
  return cmp(a, b) <= 0 ? keccak256(concat(a, b)) : keccak256(concat(b, a));
}

/** Callers pass leaves already hashed (pitfall M3). An odd node is carried up unchanged (pitfall M4). */
function layers(leaves: Uint8Array[]): Uint8Array[][] {
  if (leaves.length === 0) throw new Error('empty tree');
  const out: Uint8Array[][] = [leaves];
  while (out[out.length - 1]!.length > 1) {
    const cur = out[out.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? hashPair(cur[i]!, cur[i + 1]!) : cur[i]!);
    }
    out.push(next);
  }
  return out;
}

export const sortLeaves = (leaves: Uint8Array[]): Uint8Array[] => [...leaves].sort(cmp);

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  const l = layers(leaves);
  return l[l.length - 1]![0]!;
}

export function merkleProof(leaves: Uint8Array[], index: number): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new RangeError('leaf index');
  const l = layers(leaves);
  const proof: Uint8Array[] = [];
  let idx = index;
  for (let lvl = 0; lvl < l.length - 1; lvl++) {
    const sib = idx ^ 1;
    if (sib < l[lvl]!.length) proof.push(l[lvl]![sib]!);
    idx = idx >> 1;
  }
  return proof;
}

export function verifyMerkleProof(leaf: Uint8Array, proof: Uint8Array[], root: Uint8Array): boolean {
  let h = leaf;
  for (const p of proof) h = hashPair(h, p);
  return bytesEqual(h, root);
}
