import { computeCid } from './cid';

export class CidMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CidMismatchError';
  }
}

export interface IpfsClientOptions {
  /** One or more pin-gateway base URLs (the relay). Reads try each in turn. */
  gateways: string[];
  timeoutMs?: number; // default 10 000 (Flow D step D10)
  retries?: number; // default 3
  backoffMs?: number; // default 250
  fetchImpl?: typeof fetch;
  /** Hook for the evaluation harness: IPFS fetch time p50/p95 (SYSTEM_DESIGN section 12). */
  onTiming?: (op: 'add' | 'cat', ms: number, ok: boolean) => void;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Browser-safe adapter. Talks ONLY to the relay's pin gateway (POST /blob, GET /blob/:cid).
 * Every response is verified by recomputing the CID locally; the gateway is never trusted.
 */
export class IpfsClient {
  private o: Required<Omit<IpfsClientOptions, 'onTiming'>> & Pick<IpfsClientOptions, 'onTiming'>;

  constructor(opts: IpfsClientOptions) {
    if (opts.gateways.length === 0) throw new Error('at least one gateway required');
    this.o = {
      gateways: opts.gateways.map((g) => g.replace(/\/+$/, '')),
      timeoutMs: opts.timeoutMs ?? 10_000,
      retries: opts.retries ?? 3,
      backoffMs: opts.backoffMs ?? 250,
      fetchImpl: opts.fetchImpl ?? ((...a) => fetch(...a)),
      onTiming: opts.onTiming,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  private async timedFetch(url: string, init: RequestInit): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    try {
      return await this.o.fetchImpl(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Upload bytes; returns the CID after confirming it equals the locally computed CID. */
  async add(bytes: Uint8Array): Promise<string> {
    const localCid = await computeCid(bytes);
    const start = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      const gw = this.o.gateways[attempt % this.o.gateways.length]!;
      try {
        const res = await this.timedFetch(`${gw}/blob`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes as BodyInit,
        });
        if (!res.ok) throw new Error(`gateway ${res.status}`);
        const body = (await res.json()) as { cid?: unknown };
        if (typeof body.cid !== 'string') throw new Error('gateway returned no cid');
        if (body.cid !== localCid) throw new CidMismatchError('gateway CID differs from local CID');
        this.o.onTiming?.('add', Date.now() - start, true);
        return localCid;
      } catch (e) {
        if (e instanceof CidMismatchError) {
          this.o.onTiming?.('add', Date.now() - start, false);
          throw e; // never retry a mismatch: it indicates a misbehaving gateway
        }
        lastErr = e;
        if (attempt < this.o.retries) await this.o.sleep(this.o.backoffMs * 2 ** attempt);
      }
    }
    this.o.onTiming?.('add', Date.now() - start, false);
    throw new Error(`ipfs add failed: ${String(lastErr)}`);
  }

  /** Fetch bytes by CID, retrying across gateways, and verify hash(bytes) == cid. */
  async cat(cid: string): Promise<Uint8Array> {
    const start = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.o.retries; attempt++) {
      const gw = this.o.gateways[attempt % this.o.gateways.length]!;
      try {
        const res = await this.timedFetch(`${gw}/blob/${encodeURIComponent(cid)}`, { method: 'GET' });
        if (!res.ok) throw new Error(`gateway ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if ((await computeCid(bytes)) !== cid) throw new CidMismatchError('content does not match CID');
        this.o.onTiming?.('cat', Date.now() - start, true);
        return bytes;
      } catch (e) {
        lastErr = e;
        if (attempt < this.o.retries) await this.o.sleep(this.o.backoffMs * 2 ** attempt);
      }
    }
    this.o.onTiming?.('cat', Date.now() - start, false);
    throw lastErr instanceof CidMismatchError ? lastErr : new Error(`ipfs cat failed: ${String(lastErr)}`);
  }
}
