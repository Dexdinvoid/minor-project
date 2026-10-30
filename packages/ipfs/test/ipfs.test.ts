import { describe, expect, it } from 'vitest';
import { CidMismatchError, IpfsClient, MemoryPinStore, computeCid } from '../src';

const enc = (s: string) => new TextEncoder().encode(s);

/** In-process stand-in for the relay's pin gateway, exposed through a fetch function. */
function gatewayFetch(store: MemoryPinStore, opts: { failFirst?: number; lieAboutCid?: boolean } = {}) {
  let calls = 0;
  const f = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls++;
    if (opts.failFirst && calls <= opts.failFirst) throw new Error('network down');
    const u = String(url);
    if (init?.method === 'POST' && u.endsWith('/blob')) {
      const cid = await store.add(new Uint8Array(init.body as Uint8Array));
      return new Response(JSON.stringify({ cid: opts.lieAboutCid ? 'bafkreifake' : cid }), { status: 200 });
    }
    const m = /\/blob\/(.+)$/.exec(u);
    if (m) {
      const b = await store.cat(decodeURIComponent(m[1]!));
      return b ? new Response(b as BodyInit, { status: 200 }) : new Response('nf', { status: 404 });
    }
    return new Response('?', { status: 400 });
  };
  return { f: f as typeof fetch, calls: () => calls };
}

describe('computeCid', () => {
  it('matches the well-known CIDv1 (raw, sha2-256) of empty input', async () => {
    expect(await computeCid(new Uint8Array(0))).toBe('bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
  });
  it('is deterministic and content sensitive', async () => {
    expect(await computeCid(enc('a'))).toBe(await computeCid(enc('a')));
    expect(await computeCid(enc('a'))).not.toBe(await computeCid(enc('b')));
  });
  it('refuses blobs larger than one chunk', async () => {
    await expect(computeCid(new Uint8Array(256 * 1024 + 1))).rejects.toThrow();
  });
});

describe('IpfsClient', () => {
  const sleep = async () => {};

  it('add then cat returns the exact bytes and the CID matches the local hash', async () => {
    const store = new MemoryPinStore(computeCid);
    const { f } = gatewayFetch(store);
    const c = new IpfsClient({ gateways: ['http://relay'], fetchImpl: f, sleep });
    const data = enc('ciphertext-bytes-\u0000\u00ff');
    const cid = await c.add(data);
    expect(cid).toBe(await computeCid(data));
    expect(Array.from(await c.cat(cid))).toEqual(Array.from(data));
  });

  it('aborts add when the gateway returns a CID that differs from the local one', async () => {
    const { f } = gatewayFetch(new MemoryPinStore(computeCid), { lieAboutCid: true });
    const c = new IpfsClient({ gateways: ['http://relay'], fetchImpl: f, sleep });
    await expect(c.add(enc('x'))).rejects.toBeInstanceOf(CidMismatchError);
  });

  it('rejects content that was swapped by the gateway (hash != CID)', async () => {
    const store = new MemoryPinStore(computeCid);
    const { f } = gatewayFetch(store);
    const c = new IpfsClient({ gateways: ['http://relay'], fetchImpl: f, sleep, retries: 1 });
    const cid = await c.add(enc('original'));
    store.corrupt(cid, enc('tampered'));
    await expect(c.cat(cid)).rejects.toBeInstanceOf(CidMismatchError);
  });

  it('retries transient failures and then succeeds', async () => {
    const store = new MemoryPinStore(computeCid);
    const { f, calls } = gatewayFetch(store, { failFirst: 2 });
    const c = new IpfsClient({ gateways: ['http://a', 'http://b'], fetchImpl: f, sleep });
    await c.add(enc('retry me'));
    expect(calls()).toBe(3);
  });

  it('gives up after the configured retries and reports an error', async () => {
    const { f } = gatewayFetch(new MemoryPinStore(computeCid), { failFirst: 99 });
    const c = new IpfsClient({ gateways: ['http://a'], fetchImpl: f, sleep, retries: 2 });
    await expect(c.add(enc('x'))).rejects.toThrow(/ipfs add failed/);
  });

  it('reports timings through onTiming', async () => {
    const seen: string[] = [];
    const { f } = gatewayFetch(new MemoryPinStore(computeCid));
    const c = new IpfsClient({ gateways: ['http://a'], fetchImpl: f, sleep, onTiming: (op, _ms, ok) => seen.push(`${op}:${ok}`) });
    const cid = await c.add(enc('t'));
    await c.cat(cid);
    expect(seen).toEqual(['add:true', 'cat:true']);
  });
});
