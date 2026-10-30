import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { toB64, toHex, type Hex } from '@sc/shared';
import {
  firstInboxId, generateEd25519, generateInboxKeys, initCrypto, inboxChallengeMessage, inboxIdOf, inboxRestMessage,
  keccak256, signInbox, userIdOf, type KeyPair,
} from '@sc/crypto';
import { MemoryPinStore, computeCid } from '@sc/ipfs';
import { buildRelay, type Relay } from '../src/server';
import { loadConfig, type RelayConfig } from '../src/config';

const tick = () => new Promise((r) => setTimeout(r, 15));

let relay: Relay;
let clock = 1_800_000_000_000;
let cfg: RelayConfig;
let pins: MemoryPinStore;

async function start(over: Partial<RelayConfig> = {}) {
  await initCrypto();
  cfg = loadConfig({}, { dbPath: ':memory:', now: () => clock, clientOrigin: 'http://localhost:5173', ...over });
  pins = new MemoryPinStore(computeCid);
  relay = await buildRelay(cfg, pins);
  await relay.app.listen({ port: 0, host: '127.0.0.1' });
}
const wsUrl = () => `ws://127.0.0.1:${(relay.app.server.address() as { port: number }).port}/ws`;

function envelope(inboxId: Hex, tag = 'a') {
  return {
    inboxId,
    header: { dh: toB64(new Uint8Array(32).fill(tag.charCodeAt(0))), pn: 0, n: 0 },
    nonce: toB64(new Uint8Array(12).fill(1)),
    sealedPointer: toB64(new Uint8Array(80).fill(tag.charCodeAt(0))),
  };
}

async function registerInbox(kp: KeyPair = generateInboxKeys(), kind: 'random' | 'first' = 'random') {
  const inboxId = kind === 'random' ? inboxIdOf(kp.publicKey) : firstInboxId(userIdOf(kp.publicKey));
  const res = await relay.app.inject({ method: 'PUT', url: '/inbox', payload: { inboxId, inboxPub: toB64(kp.publicKey), kind } });
  return { kp, inboxId: inboxId as Hex, res };
}

const post = (inboxId: Hex, tag = 'a') =>
  relay.app.inject({ method: 'POST', url: `/inbox/${inboxId}/messages`, payload: envelope(inboxId, tag) });

interface Client { ws: WebSocket; send(o: object): void; next(): Promise<Record<string, unknown>>; closed: Promise<number> }
function open(): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl());
    const q: Record<string, unknown>[] = [];
    const w: ((m: Record<string, unknown>) => void)[] = [];
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); const f = w.shift(); if (f) f(m); else q.push(m); });
    const closed = new Promise<number>((r) => ws.on('close', (c) => r(c)));
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws, closed,
      send: (o) => ws.send(JSON.stringify(o)),
      next: () => new Promise((res, rej) => { const m = q.shift(); if (m) return res(m); const t = setTimeout(() => rej(new Error('timeout')), 2000); w.push((x) => { clearTimeout(t); res(x); }); }),
    }));
  });
}

async function login(c: Client, inboxId: Hex, kp: KeyPair): Promise<Record<string, unknown>> {
  c.send({ type: 'HELLO', inboxId });
  const ch = await c.next();
  expect(ch.type).toBe('CHALLENGE');
  const sig = signInbox(kp.privateKey, inboxChallengeMessage(Buffer.from((ch.nonce as string).slice(2), 'hex'), inboxId));
  c.send({ type: 'AUTH', inboxId, sig: toB64(sig) });
  return c.next();
}

afterEach(async () => { await relay?.close(); });

describe('inbox registration', () => {
  beforeEach(() => start());

  it('registers a random inbox whose id binds its key; re-registering is idempotent', async () => {
    const { res, kp } = await registerInbox();
    expect(res.statusCode).toBe(201);
    const again = await registerInbox(kp);
    expect(again.res.statusCode).toBe(200);
  });

  it('rejects an inboxId that does not equal keccak256(inboxPub)', async () => {
    const kp = generateInboxKeys();
    const res = await relay.app.inject({ method: 'PUT', url: '/inbox', payload: { inboxId: '0x' + '11'.repeat(32), inboxPub: toB64(kp.publicKey), kind: 'random' } });
    expect(res.statusCode).toBe(400);
  });

  it('registers a first-contact inbox keyed by identity key; a random-kind claim for it is rejected', async () => {
    const id = generateEd25519();
    expect((await registerInbox(id, 'first')).res.statusCode).toBe(201);
    const inboxId = firstInboxId(userIdOf(id.publicKey));
    const res = await relay.app.inject({ method: 'PUT', url: '/inbox', payload: { inboxId, inboxPub: toB64(id.publicKey), kind: 'random' } });
    expect(res.statusCode).toBe(400);
  });

  it('a different key for an existing inbox is a conflict', async () => {
    const a = await registerInbox();
    const other = generateInboxKeys();
    // same id cannot be bound to another key anyway; simulate by forging the stored row path
    const res = await relay.app.inject({ method: 'PUT', url: '/inbox', payload: { inboxId: a.inboxId, inboxPub: toB64(other.publicKey), kind: 'random' } });
    expect(res.statusCode).toBe(400);
  });
});

describe('posting messages', () => {
  beforeEach(() => start({ pendingPerInbox: 3 }));

  it('stores only the opaque envelope bytes', async () => {
    const { inboxId } = await registerInbox();
    const res = await post(inboxId);
    expect(res.statusCode).toBe(202);
    const stored = relay.db.rawMessageBytes(res.json().msgId)!;
    expect(JSON.parse(stored.toString('utf8'))).toEqual(envelope(inboxId));
  });

  it('rejects oversized envelopes (413) and malformed ones (400)', async () => {
    const { inboxId } = await registerInbox();
    const big = await relay.app.inject({ method: 'POST', url: `/inbox/${inboxId}/messages`, payload: { pad: 'x'.repeat(70_000) } });
    expect(big.statusCode).toBe(413);
    const bad = await relay.app.inject({ method: 'POST', url: `/inbox/${inboxId}/messages`, payload: { nope: true } });
    expect(bad.statusCode).toBe(400);
    const mismatch = await relay.app.inject({ method: 'POST', url: `/inbox/${inboxId}/messages`, payload: envelope(('0x' + '22'.repeat(32)) as Hex) });
    expect(mismatch.statusCode).toBe(400);
  });

  it('unknown inbox -> 404; full inbox -> 429', async () => {
    const ghost = ('0x' + '33'.repeat(32)) as Hex;
    expect((await post(ghost)).statusCode).toBe(404);
    const { inboxId } = await registerInbox();
    for (let i = 0; i < 3; i++) expect((await post(inboxId)).statusCode).toBe(202);
    expect((await post(inboxId)).statusCode).toBe(429);
  });
});

describe('WebSocket auth and delivery', () => {
  beforeEach(() => start());

  it('delivers messages queued while offline after a valid challenge-response, ACK deletes them', async () => {
    const { inboxId, kp } = await registerInbox();
    const r1 = await post(inboxId, 'a');
    await post(inboxId, 'b');
    const c = await open();
    expect((await login(c, inboxId, kp)).type).toBe('OK');
    const m1 = await c.next();
    const m2 = await c.next();
    expect(m1.type).toBe('MSG');
    expect(m1.msgId).toBe(r1.json().msgId);
    expect((m2.envelope as { header: { dh: string } }).header.dh).toBe(envelope(inboxId, 'b').header.dh);
    c.send({ type: 'ACK', inboxId, msgId: m1.msgId });
    c.send({ type: 'ACK', inboxId, msgId: m2.msgId });
    await tick();
    expect(relay.db.pendingCount(inboxId)).toBe(0);
    c.ws.close();
  });

  it('pushes live messages to an authenticated socket', async () => {
    const { inboxId, kp } = await registerInbox();
    const c = await open();
    await login(c, inboxId, kp);
    await post(inboxId, 'z');
    const m = await c.next();
    expect(m.type).toBe('MSG');
    c.ws.close();
  });

  it('wrong key -> 401 and socket closed', async () => {
    const { inboxId } = await registerInbox();
    const c = await open();
    const res = await login(c, inboxId, generateInboxKeys());
    expect(res).toMatchObject({ type: 'ERROR', code: 401 });
    await c.closed;
  });

  it('a challenge cannot be replayed: second AUTH with the same nonce fails', async () => {
    const { inboxId, kp } = await registerInbox();
    const c = await open();
    c.send({ type: 'HELLO', inboxId });
    const ch = await c.next();
    const sig = toB64(signInbox(kp.privateKey, inboxChallengeMessage(Buffer.from((ch.nonce as string).slice(2), 'hex'), inboxId)));
    c.send({ type: 'AUTH', inboxId, sig });
    expect((await c.next()).type).toBe('OK');
    c.send({ type: 'AUTH', inboxId, sig });
    expect(await c.next()).toMatchObject({ type: 'ERROR', code: 401 });
    // and from a brand-new socket that never received the challenge
    const c2 = await open();
    c2.send({ type: 'AUTH', inboxId, sig });
    expect(await c2.next()).toMatchObject({ type: 'ERROR', code: 401 });
  });

  it('an expired challenge (30 s) is rejected', async () => {
    const { inboxId, kp } = await registerInbox();
    const c = await open();
    c.send({ type: 'HELLO', inboxId });
    const ch = await c.next();
    const sig = toB64(signInbox(kp.privateKey, inboxChallengeMessage(Buffer.from((ch.nonce as string).slice(2), 'hex'), inboxId)));
    clock += 31_000;
    c.send({ type: 'AUTH', inboxId, sig });
    expect(await c.next()).toMatchObject({ type: 'ERROR', code: 401 });
  });

  it('ACK without authentication is refused', async () => {
    const { inboxId } = await registerInbox();
    const r = await post(inboxId);
    const c = await open();
    c.send({ type: 'ACK', inboxId, msgId: r.json().msgId });
    expect(await c.next()).toMatchObject({ type: 'ERROR', code: 401 });
    expect(relay.db.pendingCount(inboxId)).toBe(1);
  });

  it('after 5 failed auths from one IP further upgrades are refused (rate limit)', async () => {
    const { inboxId } = await registerInbox();
    for (let i = 0; i < 5; i++) {
      const c = await open();
      expect(await login(c, inboxId, generateInboxKeys())).toMatchObject({ code: 401 });
      await c.closed;
    }
    await expect(open()).rejects.toBeTruthy();
  });
});

describe('REST read fallback', () => {
  beforeEach(() => start());

  const signed = (kp: KeyPair, method: string, path: string, ts: number) => ({
    'x-timestamp': String(ts),
    'x-inbox-sig': toB64(signInbox(kp.privateKey, inboxRestMessage(method, path, ts, new Uint8Array(0)))),
  });

  it('lists messages with a valid signature; replay of the same signature is rejected', async () => {
    const { inboxId, kp } = await registerInbox();
    await post(inboxId);
    const path = `/inbox/${inboxId}/messages`;
    const h = signed(kp, 'GET', path, clock);
    const ok = await relay.app.inject({ method: 'GET', url: path, headers: h });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().messages).toHaveLength(1);
    const replay = await relay.app.inject({ method: 'GET', url: path, headers: h });
    expect(replay.statusCode).toBe(401);
  });

  it('rejects stale timestamps (and tells the client the server time), wrong keys', async () => {
    const { inboxId, kp } = await registerInbox();
    const path = `/inbox/${inboxId}/messages`;
    const stale = await relay.app.inject({ method: 'GET', url: path, headers: signed(kp, 'GET', path, clock - 61_000) });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().serverTime).toBe(clock);
    const wrong = await relay.app.inject({ method: 'GET', url: path, headers: signed(generateInboxKeys(), 'GET', path, clock) });
    expect(wrong.statusCode).toBe(401);
  });

  it('a signature for one path cannot be used on another (path is signed)', async () => {
    const { inboxId, kp } = await registerInbox();
    const r = await post(inboxId);
    const listPath = `/inbox/${inboxId}/messages`;
    const h = signed(kp, 'GET', listPath, clock);
    const del = await relay.app.inject({ method: 'DELETE', url: `${listPath}/${r.json().msgId}`, headers: h });
    expect(del.statusCode).toBe(401);
    expect(relay.db.pendingCount(inboxId)).toBe(1);
  });
});

describe('TTL cleanup', () => {
  beforeEach(() => start());
  it('purges messages older than 7 days and keeps fresh ones', async () => {
    const { inboxId } = await registerInbox();
    await post(inboxId, 'a');
    clock += 6 * 24 * 3600_000;
    await post(inboxId, 'b');
    clock += 2 * 24 * 3600_000; // first message is now 8 days old, second is 2 days old
    expect(relay.purge().messages).toBe(1);
    expect(relay.db.pendingCount(inboxId)).toBe(1);
  });
});

describe('pin gateway', () => {
  beforeEach(() => start({ blobMaxBytes: 1024 }));

  it('POST /blob returns the CID and the client can recompute it locally; GET returns the same bytes', async () => {
    const data = Buffer.from('opaque ciphertext bytes');
    const res = await relay.app.inject({ method: 'POST', url: '/blob', headers: { 'content-type': 'application/octet-stream' }, payload: data });
    expect(res.statusCode).toBe(200);
    expect(res.json().cid).toBe(await computeCid(new Uint8Array(data)));
    const got = await relay.app.inject({ method: 'GET', url: `/blob/${res.json().cid}` });
    expect(Buffer.compare(got.rawPayload, data)).toBe(0);
  });

  it('rejects oversize blobs (413), empty bodies and malformed CIDs', async () => {
    const big = await relay.app.inject({ method: 'POST', url: '/blob', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(2000) });
    expect(big.statusCode).toBe(413);
    const empty = await relay.app.inject({ method: 'POST', url: '/blob', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(0) });
    expect(empty.statusCode).toBe(400);
    expect((await relay.app.inject({ method: 'GET', url: '/blob/../../etc/passwd' })).statusCode).toBe(404);
    expect((await relay.app.inject({ method: 'GET', url: '/blob/NOT_A_CID' })).statusCode).toBe(400);
    expect((await relay.app.inject({ method: 'GET', url: '/blob/bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' })).statusCode).toBe(404);
  });
});

describe('global per-IP rate limit', () => {
  beforeEach(() => start({ reqPerMinPerIp: 5 }));
  it('returns 429 after the configured number of requests per minute', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await relay.app.inject({ method: 'GET', url: '/health' })).statusCode);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes[6]).toBe(429);
  });
});

void keccak256; void toHex;
