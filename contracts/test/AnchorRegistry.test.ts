import { expect } from 'chai';
import { ethers } from 'hardhat';
import { MerkleTree } from 'merkletreejs';

// Same options the batcher uses (packages/batcher/src/tree.ts): leaves already hashed, sorted pairs.
const keccak = (d: Buffer): Buffer => Buffer.from(ethers.getBytes(ethers.keccak256(d)));
const mkLeaves = (n: number): Buffer[] =>
  Array.from({ length: n }, (_, i) => Buffer.from(ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes(`leaf-${i}`)))));
const tree = (leaves: Buffer[]) => new MerkleTree(leaves, keccak, { hashLeaves: false, sortPairs: true, sortLeaves: true });
const hex = (b: Buffer) => '0x' + b.toString('hex');

describe('AnchorRegistry', () => {
  async function deploy() {
    const [submitter] = await ethers.getSigners();
    const reg = await ethers.deployContract('AnchorRegistry');
    return { reg, submitter: submitter! };
  }

  it('anchor stores root, leafCount, submitter and timestamp, and emits BatchAnchored', async () => {
    const { reg, submitter } = await deploy();
    const t = tree(mkLeaves(5));
    const root = hex(t.getRoot());
    await expect(reg.anchor(root, 5)).to.emit(reg, 'BatchAnchored').withArgs(0, root, 5, submitter.address);
    const b = await reg.batches(0);
    expect(b.root).to.equal(root);
    expect(b.leafCount).to.equal(5n);
    expect(b.submitter).to.equal(submitter.address);
    expect(b.anchoredAt).to.be.greaterThan(0n);
    expect(await reg.batchCount()).to.equal(1n);
  });

  it('batch ids increment', async () => {
    const { reg } = await deploy();
    const r1 = hex(tree(mkLeaves(2)).getRoot());
    const r2 = hex(tree(mkLeaves(3)).getRoot());
    await reg.anchor(r1, 2);
    await reg.anchor(r2, 3);
    expect((await reg.batches(1)).root).to.equal(r2);
  });

  it('rejects the zero root and zero leaf count', async () => {
    const { reg } = await deploy();
    await expect(reg.anchor(ethers.ZeroHash, 1)).to.be.revertedWithCustomError(reg, 'EmptyRoot');
    await expect(reg.anchor(ethers.keccak256('0x01'), 0)).to.be.revertedWithCustomError(reg, 'ZeroLeaves');
  });

  // Pitfall M4: sizes 1, 2, 3, 63, 64, 65 (odd counts) must all verify against the contract.
  for (const n of [1, 2, 3, 63, 64, 65]) {
    it(`verifyLeaf is true for every leaf of an off-chain merkletreejs tree of ${n}`, async () => {
      const { reg } = await deploy();
      const leaves = mkLeaves(n);
      const t = tree(leaves);
      await reg.anchor(hex(t.getRoot()), n);
      for (const l of leaves) {
        expect(await reg.verifyLeaf(0, hex(l), t.getHexProof(l))).to.equal(true);
      }
    });
  }

  it('verifyLeaf is false for a tampered leaf, a tampered proof and a wrong batch', async () => {
    const { reg } = await deploy();
    const leaves = mkLeaves(8);
    const t = tree(leaves);
    await reg.anchor(hex(t.getRoot()), 8);
    await reg.anchor(hex(tree(mkLeaves(3)).getRoot()), 3);
    const proof = t.getHexProof(leaves[2]!);
    const evil = ethers.keccak256(ethers.toUtf8Bytes('evil'));
    expect(await reg.verifyLeaf(0, evil, proof)).to.equal(false);
    expect(await reg.verifyLeaf(0, hex(leaves[2]!), [evil, ...proof.slice(1)])).to.equal(false);
    expect(await reg.verifyLeaf(1, hex(leaves[2]!), proof)).to.equal(false);
  });

  it('verifyLeaf is false (not a revert) for an unknown batch id', async () => {
    const { reg } = await deploy();
    expect(await reg.verifyLeaf(99, ethers.keccak256('0x01'), [])).to.equal(false);
  });
});
