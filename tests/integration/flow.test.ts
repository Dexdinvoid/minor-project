import { beforeAll, describe, expect, it } from 'vitest';
import { JsonRpcProvider, Wallet } from 'ethers';
import { config } from 'dotenv';
import { fromUtf8, toB64, toHex, utf8, type Hex } from '@sc/shared';
import {
  bundleHash, commitment, convoIdOf, firstInboxId, generateIdentity, initCrypto, initInitiator, initResponder, inboxRestMessage,
  leafOf, openBlob, openEnvelope, randomBytes, sealMessage, sealPointer, signCommitment, signInbox, x3dhInitiate, x3dhRespond,
} from '@sc/crypto';
import { IpfsClient } from '@sc/ipfs';
import { LedgerClient, makeBundleResolver, verifyFlowF } from '@sc/ledger';

config({ path: '.env' });
const RELAY = process.env.RELAY_URL ?? 'http://127.0.0.1:4000';
const BATCHER = `http://127.0.0.1:${process.env.BATCHER_PORT ?? 4100}`;

const provider = new JsonRpcProvider(process.env.CHAIN_RPC_URL);
const ledger = new LedgerClient({
  provider, signer: new Wallet(process.env.BATCHER_PRIVATE_KEY ?? '', provider),
  keyRegistry: process.env.KEY_REGISTRY_ADDRESS ?? '', anchorRegistry: process.env.ANCHOR_REGISTRY_ADDRESS ?? '',
});
const ipfs = new IpfsClient({ gateways: [RELAY] });
const resolve = makeBundleResolver({ getKeyEntry: (id) => ledger.getKeyEntry(id), fetchBlob: (c) => ipfs.cat(c) });
const json = (r: Response) => r.json() as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeAll(initCrypto);

describe('end to end: register -> encrypt -> relay -> decrypt -> sign -> anchor -> verify', () => {
  it('delivers a message and verifies it; tampering is detected', async () => {
    await ledger.assertDeployed();
    const alice = generateIdentity();
    const bob = generateIdentity();
    for (const u of [alice, bob]) {
      const cid = await ipfs.add(utf8(JSON.stringify(u.bundle)));
      await ledger.publishBundle(u.bundle.userId, bundleHash(u.bundle), cid);
      const r = await fetch(`${RELAY}/inbox`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inboxId: firstInboxId(u.bundle.userId), inboxPub: toB64(u.ed.publicKey), kind: 'first' }) });
      expect(r.status).toBeLessThan(300);
    }

    // Alice -> Bob
    const bobBundle = (await resolve(bob.bundle.userId))!.bundle;
    const init = x3dhInitiate(alice.ed, bobBundle);
    const sa = initInitiator(init.sk, init.theirSpk);
    const sealed = sealMessage(sa, utf8('hello bob, this is private'));
    const cid = await ipfs.add(sealed.blobBytes);
    const salt = randomBytes(32);
    const convoId = convoIdOf(alice.bundle.userId, bob.bundle.userId);
    const C = commitment(cid, salt);
    const sig = signCommitment(alice.ed.privateKey, C, alice.bundle.userId, convoId, 0);
    const ptr = sealPointer(sealed.pointerKey, sealed.header, { cid, salt: toB64(salt), sig: toB64(sig), seq: 0, ts: Date.now() });
    const inboxId = firstInboxId(bob.bundle.userId);
    const post = await fetch(`${RELAY}/inbox/${inboxId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inboxId, header: sealed.header, nonce: ptr.nonce, sealedPointer: ptr.sealedPointer, x3dh: init.header }) });
    expect(post.status).toBe(202);

    // Bob reads through the REST fallback and decrypts
    const path = `/inbox/${inboxId}/messages`;
    const ts = Date.now();
    const sigB = signInbox(bob.ed.privateKey, inboxRestMessage('GET', path, ts, new Uint8Array(0)));
    const list = await json(await fetch(`${RELAY}${path}`, { headers: { 'x-timestamp': String(ts), 'x-inbox-sig': toB64(sigB) } }));
    const env = list.messages[0].envelope;
    const resp = x3dhRespond(bob.ed, bob.spk, env.x3dh);
    const opened = openEnvelope(initResponder(resp.sk, bob.spk), env);
    const blob = JSON.parse(fromUtf8(await ipfs.cat(opened.pointer.cid)));
    expect(fromUtf8(openBlob(opened.encKey, blob, env.header))).toBe('hello bob, this is private');

    // Alice submits the signed leaf; the batcher anchors it (set BATCH_MAX_AGE_MS=3000 for a fast test)
    const lr = await json(await fetch(`${BATCHER}/leaf`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commitment: toHex(C), sig: toB64(sig), senderUserId: alice.bundle.userId, convoId, seq: 0 }) }));
    const leaf = toHex(leafOf(C, sig));
    expect(lr.leaf).toBe(leaf);
    let proof: Record<string, any> = { status: 'pending' }; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 60 && proof.status !== 'anchored'; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      proof = await json(await fetch(`${BATCHER}/proof/${leaf}`));
    }
    expect(proof.status).toBe('anchored');

    const deps = {
      resolveBundle: async (id: Hex) => { const r = await resolve(id); return r ? { bundle: r.bundle, onChainHash: r.onChainHash } : null; },
      getBatch: async (id: number) => { const b = await ledger.getBatch(id); return b ? { root: b.root, anchoredAt: b.anchoredAt } : null; },
      fetchBlob: (c: string) => ipfs.cat(c),
    };
    const input = { cid, salt: toB64(salt), sig: toB64(sig), seq: 0, senderUserId: alice.bundle.userId, convoId, anchor: { batchId: proof.batchId, proof: proof.proof, root: proof.root, txHash: proof.txHash } };
    expect((await verifyFlowF(input, deps)).outcome).toBe('VERIFIED');
    expect((await verifyFlowF({ ...input, seq: 1 }, deps)).outcome).toBe('INVALID_SIGNATURE');
    expect((await verifyFlowF({ ...input, anchor: { ...input.anchor, root: `0x${'11'.repeat(32)}` as Hex } }, deps)).outcome).toBe('INVALID_PROOF');
    expect((await verifyFlowF(input, { ...deps, fetchBlob: async () => { throw new Error('altered'); } })).outcome).toBe('CONTENT_ALTERED_OR_MISSING');
  });
});
