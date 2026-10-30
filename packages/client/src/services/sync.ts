import { inboxChallengeMessage, signInbox } from '@sc/crypto';
import { fromHex, toB64, type Hex, type RelayEnvelope } from '@sc/shared';

export type ConnStatus = 'connecting' | 'online' | 'offline';

type ServerFrame =
  | { type: 'CHALLENGE'; inboxId: Hex; nonce: Hex }
  | { type: 'OK'; inboxId: Hex }
  | { type: 'MSG'; inboxId: Hex; msgId: string; envelope: RelayEnvelope }
  | { type: 'ERROR'; code: number; message: string };

/**
 * WebSocket client with exponential backoff reconnect (Flow D). Messages are handled strictly one at a
 * time so two ratchet updates for the same conversation can never interleave.
 */
export class Sync {
  private ws: WebSocket | null = null;
  private keys = new Map<string, Uint8Array>(); // inboxId -> Ed25519 private key (memory only)
  private queue: Promise<void> = Promise.resolve();
  private attempt = 0;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  status: ConnStatus = 'offline';

  constructor(
    private url: string,
    private onMessage: (inboxId: Hex, msgId: string, env: RelayEnvelope) => Promise<void>,
    private onStatus: (s: ConnStatus) => void,
  ) {}

  addInbox(inboxId: Hex, privateKey: Uint8Array): void {
    this.keys.set(inboxId, privateKey);
    if (this.ws?.readyState === WebSocket.OPEN) this.send({ type: 'HELLO', inboxId });
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.ws?.close();
    this.keys.clear();
    this.setStatus('offline');
  }

  ack(inboxId: Hex, msgId: string): void {
    this.send({ type: 'ACK', inboxId, msgId });
  }

  private setStatus(s: ConnStatus) {
    this.status = s;
    this.onStatus(s);
  }

  private send(o: object) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(o));
  }

  private connect() {
    if (this.stopped) return;
    this.setStatus('connecting');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus('online');
      for (const id of this.keys.keys()) this.send({ type: 'HELLO', inboxId: id });
    };
    ws.onmessage = (ev) => {
      let f: ServerFrame;
      try {
        f = JSON.parse(String(ev.data)) as ServerFrame;
      } catch {
        return;
      }
      if (f.type === 'CHALLENGE') {
        const sk = this.keys.get(f.inboxId);
        if (!sk) return;
        const sig = signInbox(sk, inboxChallengeMessage(fromHex(f.nonce), f.inboxId));
        this.send({ type: 'AUTH', inboxId: f.inboxId, sig: toB64(sig) });
      } else if (f.type === 'MSG') {
        this.queue = this.queue
          .then(() => this.onMessage(f.inboxId, f.msgId, f.envelope))
          .catch((e) => console.error('message handler failed', (e as Error).message));
      }
    };
    ws.onclose = () => {
      this.setStatus('offline');
      if (this.stopped) return;
      const delay = Math.min(1000 * 2 ** this.attempt++, 30_000);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }
}
