// Node-only entry (relay). Browsers must never import this file (ground rule 11).
import { create, type KuboRPCClient } from 'kubo-rpc-client';
import type { PinStore } from './store';

export class KuboPinStore implements PinStore {
  private client: KuboRPCClient;
  constructor(rpcUrl: string) {
    this.client = create({ url: rpcUrl });
  }
  async add(bytes: Uint8Array): Promise<string> {
    const res = await this.client.add(bytes, { cidVersion: 1, rawLeaves: true, pin: true });
    return res.cid.toString();
  }
  async cat(cid: string): Promise<Uint8Array | null> {
    const chunks: Uint8Array[] = [];
    try {
      for await (const c of this.client.cat(cid, { timeout: 8000 })) chunks.push(c);
    } catch {
      return null;
    }
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}
