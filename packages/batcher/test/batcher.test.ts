import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toB64, toHex, type Hex } from '@sc/shared';
import {
  commitment, convoIdOf, generateIdentity, initCrypto, keccak256, merkleRoot, randomBytes, signCommitment,
  sortLeaves, verifyMerkleProof, type Identity,
} from '@sc/crypto';
import { buildBatcher, type Batcher } from '../src/server';
import { loadConfig, type BatcherConfig } from '../src/config';
import { buildTree } from '../src/tree';
import { BatcherDb } from '../src/db';
import type { Anchorer } from '../src/anchor';

let b: Batcher | undefined;
let clock = 1_800_000_000_000;
afterEach(async () => { await b?.close(); b = undefined; });

class FakeAnchorer implements Anchorer {
  calls: { root: Hex; n: number }[] = [];
  failNext = 0;
  async anchor(root: Hex, n: number) {
    if (this.failNext > 0) { this.failNext--; throw new Error('tx reverted'); }
    this.calls.push({ root, n });
    return { batchId: this.calls.length - 1, txHash: ('0x' + 'ab'.repeat(32)) as Hex, anchoredAt: Math.floor(clock / 1000), gasUsed: 50_000n, effectiveGasPrice: 2_000_000_000n };
  }
}

async function setup(over: Partial<BatcherConfig> = {}, anchorer = new FakeAnchorer(), db?: BatcherDb) {
  await initCrypto();
  const alice = generateIdentity();
  const bob = generateIdentity();
  const registry = new Map<string, Uint8Array>([[alice.bundle.userId, alice.ed.publicKey]]);
  const cfg = loadConfig({}, { dbPath: ':memory:', now: () => clock, ...over });
  b = await buildBatcher(cfg, { anchorer, keys: { getEd25519: async (id) => registry.get(id) ?? null } }, db);
  return { alice, bob, anchorer, cfg };
}

function leafReq(alice: Identity, convoId: Hex, seq: number, cid = `bafkrei${seq}`.padEnd(50, 'x')) {
  const C = commitment(cid, randomBytes(32));
  const sig = signCommitment(alice.ed.privateKey, C, alice.bundle.userId, convoId, seq);
  return { commitment: toHex(C), sig: toB64(sig), senderUserId: alice.bundle.userId, convoId, seq };
}
const submit = (body: object) => b!.app.inject({ method: 'POST', url: '/leaf', payload: body });

describe('POST /leaf', () => {
  it('accepts a valid signed leaf as pending', async () => {
    const { alice, bob } = await setup();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    const res = await submit(leafReq(alice, convo, 0));
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('rejects a bad signature (400), an unregistered sender (403) and malformed bodies (400)', async () => {
    const { alice, bob } = await setup();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    const good = leafReq(alice, convo, 0);
    const tampered = { ...good, seq: 1 }; // signature was for seq 0
    expect((await submit(tampered)).statusCode).toBe(400);
    const stranger = leafReq(bob, convo, 0);
    expect((await submit(stranger)).statusCode).toBe(403);
    expect((await submit({ nope: 1 })).statusCode).toBe(400);
  });

  it('rejects a replayed seq carrying a different message (409) but accepts an identical retry', async () => {
    const { alice, bob } = await setup();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    const first = leafReq(alice, convo, 5);
    const r1 = await submit(first);
    const retry = await submit(first);
    expect(retry.json().leaf).toBe(r1.json().leaf);
    expect((await submit(leafReq(alice, convo, 5))).statusCode).toBe(409);
  });
});

describe('flush policy', () => {
  it('does not flush below 64 leaves before 60 s, flushes at 64', async () => {
    const { alice, bob, anchorer } = await setup();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    for (let i = 0; i < 63; i++) await submit(leafReq(alice, convo, i));
    expect(await b!.flushOnce()).toBe(0);
    await submit(leafReq(alice, convo, 63));
    expect(await b!.flushOnce()).toBe(64);
    expect(anchorer.calls).toHaveLength(1);
    expect(anchorer.calls[0]!.n).toBe(64);
  });

  it('flushes a small batch once the oldest leaf is 60 s old', async () => {
    const { alice, bob, anchorer } = await setup();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    await submit(leafReq(alice, convo, 0));
    expect(await b!.flushOnce()).toBe(0);
    clock += 60_000;
    expect(await b!.flushOnce()).toBe(1);
    expect(anchorer.calls).toHaveLength(1);
  });

  it('proofs returned by GET /proof verify against the anchored root', async () => {
    const { alice, bob, anchorer } = await setup();
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    const leaves: string[] = [];
    for (let i = 0; i < 9; i++) leaves.push((await submit(leafReq(alice, convo, i))).json().leaf);
    expect((await b!.app.inject({ url: `/proof/${leaves[0]}` })).json().status).toBe('pending');
    clock += 61_000;
    await b!.flushOnce();
    for (const l of leaves) {
      const p = (await b!.app.inject({ url: `/proof/${l}` })).json();
      expect(p.status).toBe('anchored');
      expect(p.root).toBe(anchorer.calls[0]!.root);
      const ok = verifyMerkleProof(Buffer.from(l.slice(2), 'hex'), p.proof.map((h: string) => Buffer.from(h.slice(2), 'hex')), Buffer.from(p.root.slice(2), 'hex'));
      expect(ok).toBe(true);
    }
    expect((await b!.app.inject({ url: `/proof/0x${'00'.repeat(32)}` })).statusCode).toBe(404);
  });

  it('keeps leaves pending when anchoring fails and retries after backoff', async () => {
    const a = new FakeAnchorer();
    a.failNext = 1;
    const { alice, bob } = await setup({}, a);
    const convo = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    await submit(leafReq(alice, convo, 0));
    clock += 61_000;
    expect(await b!.flushOnce()).toBe(0);
    expect(b!.db.pendingCount()).toBe(1);
    expect(await b!.flushOnce()).toBe(0); // still inside the backoff window
    clock += 3_000;
    expect(await b!.flushOnce()).toBe(1);
    expect(b!.db.pendingCount()).toBe(0);
  });

  it('survives a restart: pending leaves persist and anchor afterwards', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'batcher-')), 'b.db');
    const first = await setup({ dbPath: path });
    const convo = convoIdOf(first.alice.bundle.userId, first.bob.bundle.userId);
    await submit(leafReq(first.alice, convo, 0));
    await b!.close();
    const anchorer = new FakeAnchorer();
    b = await buildBatcher(loadConfig({}, { dbPath: path, now: () => clock }), { anchorer, keys: { getEd25519: async () => null } });
    expect(b.db.pendingCount()).toBe(1);
    clock += 61_000;
    expect(await b.flushOnce()).toBe(1);
  });
});

describe('merkletreejs vs @sc/crypto (pitfalls M1, M3, M4)', () => {
  it.each([1, 2, 3, 63, 64, 65])('same root and valid proofs for %i leaves', async (n) => {
    await initCrypto();
    const hexLeaves = Array.from({ length: n }, (_, i) => toHex(keccak256(new Uint8Array([i, i >> 8, 7])))) as Hex[];
    const { root, proofs } = buildTree(hexLeaves);
    const mine = sortLeaves(hexLeaves.map((h) => Buffer.from(h.slice(2), 'hex')));
    expect(root).toBe(toHex(merkleRoot(mine)));
    for (const l of hexLeaves) {
      const ok = verifyMerkleProof(Buffer.from(l.slice(2), 'hex'), proofs.get(l)!.map((h) => Buffer.from(h.slice(2), 'hex')), Buffer.from(root.slice(2), 'hex'));
      expect(ok).toBe(true);
    }
  });
});
