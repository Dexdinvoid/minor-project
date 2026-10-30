/** Server-side pin store used by the relay's pin gateway. Kubo in production, memory in tests. */
export interface PinStore {
  add(bytes: Uint8Array): Promise<string>; // returns CIDv1 string
  cat(cid: string): Promise<Uint8Array | null>;
}

export class MemoryPinStore implements PinStore {
  private blobs = new Map<string, Uint8Array>();
  constructor(private cidOf: (b: Uint8Array) => Promise<string>) {}
  async add(bytes: Uint8Array): Promise<string> {
    const cid = await this.cidOf(bytes);
    this.blobs.set(cid, bytes.slice());
    return cid;
  }
  async cat(cid: string): Promise<Uint8Array | null> {
    return this.blobs.get(cid)?.slice() ?? null;
  }
  /** test helper: simulate a malicious gateway */
  corrupt(cid: string, bytes: Uint8Array): void {
    this.blobs.set(cid, bytes);
  }
}
