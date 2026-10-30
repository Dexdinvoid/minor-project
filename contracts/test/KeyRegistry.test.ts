import { expect } from 'chai';
import { ethers } from 'hardhat';

const USER = ethers.keccak256(ethers.toUtf8Bytes('alice-identity-key'));
const H1 = ethers.keccak256(ethers.toUtf8Bytes('bundle-1'));
const H2 = ethers.keccak256(ethers.toUtf8Bytes('bundle-2'));
const CID1 = 'bafkreibundlecid1';
const CID2 = 'bafkreibundlecid2';

describe('KeyRegistry', () => {
  async function deploy() {
    const [owner, other] = await ethers.getSigners();
    const reg = await ethers.deployContract('KeyRegistry');
    return { reg, owner: owner!, other: other! };
  }

  it('first publish makes the caller owner and sets version 1', async () => {
    const { reg, owner } = await deploy();
    await expect(reg.publish(USER, H1, CID1)).to.emit(reg, 'BundlePublished').withArgs(USER, 1, H1, CID1);
    const e = await reg.entries(USER);
    expect(e.owner).to.equal(owner.address);
    expect(e.bundleHash).to.equal(H1);
    expect(e.bundleCid).to.equal(CID1);
    expect(e.version).to.equal(1n);
    expect(e.updatedAt).to.be.greaterThan(0n);
  });

  it('owner can update; version increments', async () => {
    const { reg } = await deploy();
    await reg.publish(USER, H1, CID1);
    await reg.publish(USER, H2, CID2);
    const e = await reg.entries(USER);
    expect(e.version).to.equal(2n);
    expect(e.bundleHash).to.equal(H2);
    expect(e.bundleCid).to.equal(CID2);
  });

  it('a different address cannot update an existing userId', async () => {
    const { reg, other } = await deploy();
    await reg.publish(USER, H1, CID1);
    await expect(reg.connect(other).publish(USER, H2, CID2)).to.be.revertedWithCustomError(reg, 'NotOwner');
    expect((await reg.entries(USER)).bundleHash).to.equal(H1);
  });

  it('different users are independent', async () => {
    const { reg, other } = await deploy();
    const USER2 = ethers.keccak256(ethers.toUtf8Bytes('bob-identity-key'));
    await reg.publish(USER, H1, CID1);
    await reg.connect(other).publish(USER2, H2, CID2);
    expect((await reg.entries(USER2)).owner).to.equal(other.address);
  });

  it('rejects an empty hash, an empty CID and an oversized CID', async () => {
    const { reg } = await deploy();
    await expect(reg.publish(USER, ethers.ZeroHash, CID1)).to.be.revertedWithCustomError(reg, 'EmptyBundleHash');
    await expect(reg.publish(USER, H1, '')).to.be.revertedWithCustomError(reg, 'InvalidCid');
    await expect(reg.publish(USER, H1, 'x'.repeat(129))).to.be.revertedWithCustomError(reg, 'InvalidCid');
  });

  it('reading an unknown userId returns an empty entry', async () => {
    const { reg } = await deploy();
    const e = await reg.entries(USER);
    expect(e.owner).to.equal(ethers.ZeroAddress);
    expect(e.version).to.equal(0n);
  });
});
