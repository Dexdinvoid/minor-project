import { JsonRpcProvider, Wallet } from 'ethers';
import {
  bundleHash, commitment, convoIdOf, firstInboxId, generateInboxKeys, inboxIdOf, initInitiator,
  initResponder, leafOf, openBlob, openEnvelope, randomBytes, sealMessage, sealPointer, signCommitment, userIdOf,
  verifyBundle, wipe, x3dhInitiate, x3dhRespond, deserializeRatchet, serializeRatchet, type RatchetState,
} from '@sc/crypto';
import {
  LIMITS, fromB64, fromUtf8, toB64, toHex, utf8,
  type AppPayload, type Hex, type KeyBundle, type ProofPackage, type RelayEnvelope,
} from '@sc/shared';
import { BlobEnvelopeSchema, ProofResponseSchema } from '@sc/shared/schemas';
import { IpfsClient } from '@sc/ipfs';
import { LedgerClient, makeBundleResolver, verifyFlowF, type FlowFResult } from '@sc/ledger';
import { ENV, wsUrl } from '../env';
import { appDb, type ContactRow, type MessageRow, type SessionRow } from './db';
import { Sync, type ConnStatus } from './sync';
import type { Vault } from './vault';

export type OnboardStep = 'keys' | 'upload' | 'funding' | 'register' | 'inbox' | 'done';

interface SessionSecrets {
  ratchet: string;
  inboxPriv: string;
}

const HEX32 = /^0x[0-9a-f]{64}$/;

async function http<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; body: T }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 10_000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
  } finally {
    clearTimeout(t);
  }
}
const postJson = <T>(url: string, body: unknown) =>
  http<T>(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Application service layer (Flows A-F). UI components never touch keys: they call this class,
 * which owns the Vault, the sockets and the adapters (pitfall U3).
 */
export class Messenger {
  readonly ipfs = new IpfsClient({ gateways: [ENV.relayUrl] });
  readonly provider = new JsonRpcProvider(ENV.rpcUrl);
  private sync: Sync | null = null;
  private locks = new Map<string, Promise<unknown>>();
  private proofTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly vault: Vault,
    private hooks: { onChange: () => void; onConn: (s: ConnStatus) => void },
  ) {}

  // ---------- plumbing ----------
  private ledgerRO = () => new LedgerClient({ provider: this.provider, keyRegistry: ENV.keyRegistry, anchorRegistry: ENV.anchorRegistry });
  private ledgerRW = () =>
    new LedgerClient({
      provider: this.provider, signer: new Wallet(this.vault.walletKey, this.provider),
      keyRegistry: ENV.keyRegistry, anchorRegistry: ENV.anchorRegistry,
    });

  private resolveBundle = (userId: Hex) =>
    makeBundleResolver({ getKeyEntry: (id) => this.ledgerRO().getKeyEntry(id), fetchBlob: (cid) => this.ipfs.cat(cid) })(userId);

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }

  private async registerInbox(inboxId: Hex, pub: Uint8Array, kind: 'random' | 'first') {
    const r = await http(`${ENV.relayUrl}/inbox`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inboxId, inboxPub: toB64(pub), kind }),
    });
    if (r.status >= 400) throw new Error(`relay refused inbox registration (${r.status})`);
  }

  // ---------- Flow A: onboarding ----------
  async onboard(name: string, passphrase: string, progress: (s: OnboardStep) => void): Promise<void> {
    progress('keys');
    const { bundleBytes } = await this.vault.create(name, passphrase);
    progress('upload');
    const cid = await this.ipfs.add(bundleBytes);
    progress('funding');
    const wallet = new Wallet(this.vault.walletKey);
    const f = await postJson(`${ENV.batcherUrl}/dev/faucet`, { address: wallet.address });
    if (f.status >= 400) throw new Error('could not fund the wallet (is DEV_FAUCET enabled on the batcher?)');
    progress('register');
    await this.ledgerRW().publishBundle(this.vault.userId, bundleHash(this.vault.bundle), cid);
    progress('inbox');
    await this.registerInbox(firstInboxId(this.vault.userId), this.vault.ed.publicKey, 'first');
    await this.start();
    progress('done');
  }

  async unlock(passphrase: string): Promise<void> {
    await this.vault.unlock(passphrase);
    await this.start();
  }

  async start(): Promise<void> {
    this.sync?.stop();
    const s = new Sync(wsUrl(), (i, m, e) => this.handleIncoming(i, m, e), this.hooks.onConn);
    const first = firstInboxId(this.vault.userId);
    await this.registerInbox(first, this.vault.ed.publicKey, 'first').catch(() => undefined); // relay may have been reset
    s.addInbox(first, this.vault.ed.privateKey);
    for (const row of await appDb.sessions.toArray()) {
      const sec = JSON.parse(this.vault.open(row.convoId, row.enc)) as SessionSecrets;
      s.addInbox(row.myInboxId, fromB64(sec.inboxPriv));
    }
    this.sync = s;
    s.start();
    clearInterval(this.proofTimer);
    this.proofTimer = setInterval(() => void this.pollProofs(), 10_000);
  }

  lock(): void {
    clearInterval(this.proofTimer);
    this.sync?.stop();
    this.vault.lock();
  }

  // ---------- Flow B: contacts ----------
  async addContact(userId: string, name: string): Promise<ContactRow> {
    const id = userId.trim().toLowerCase() as Hex;
    if (!HEX32.test(id)) throw new Error('That does not look like a valid ID.');
    if (id === this.vault.userId) throw new Error('That is your own ID.');
    const r = await this.resolveBundle(id);
    if (!r) throw new Error('This ID is not registered.');
    if (bundleHash(r.bundle) !== r.onChainHash.toLowerCase() || !verifyBundle(r.bundle).ok || r.bundle.userId !== id) {
      throw new Error('KEY MISMATCH: the keys published for this ID are not valid. Do not message this contact.');
    }
    const row: ContactRow = { userId: id, name: name.trim() || id.slice(0, 10), bundle: r.bundle, addedAt: Date.now() };
    await appDb.contacts.put(row);
    this.hooks.onChange();
    return row;
  }

  // ---------- Flow C: send ----------
  private async loadSecrets(row: SessionRow): Promise<{ ratchet: RatchetState; inboxPriv: Uint8Array }> {
    const sec = JSON.parse(this.vault.open(row.convoId, row.enc)) as SessionSecrets;
    return { ratchet: deserializeRatchet(sec.ratchet), inboxPriv: fromB64(sec.inboxPriv) };
  }

  private sealSecrets(convoId: Hex, ratchet: RatchetState, inboxPriv: Uint8Array) {
    return this.vault.seal(convoId, JSON.stringify({ ratchet: serializeRatchet(ratchet), inboxPriv: toB64(inboxPriv) } satisfies SessionSecrets));
  }

  async setVerifiable(convoId: Hex, on: boolean): Promise<void> {
    await appDb.sessions.update(convoId, { verifiable: on });
    this.hooks.onChange();
  }

  async send(peerUserId: Hex, text: string, verifiable: boolean, retryOf?: number): Promise<void> {
    const convoId = convoIdOf(this.vault.userId, peerUserId);
    if (retryOf !== undefined) await appDb.messages.delete(retryOf);
    return this.withLock(convoId, async () => {
      const contact = await appDb.contacts.get(peerUserId);
      let row = await appDb.sessions.get(convoId);
      let ratchet: RatchetState;
      let inboxPriv: Uint8Array;

      if (!row) {
        if (!contact?.bundle) throw new Error('Add this contact first.');
        const init = x3dhInitiate(this.vault.ed, contact.bundle as KeyBundle);
        ratchet = initInitiator(init.sk, init.theirSpk);
        wipe(init.sk);
        const inbox = generateInboxKeys();
        inboxPriv = inbox.privateKey;
        const myInboxId = inboxIdOf(inbox.publicKey);
        await this.registerInbox(myInboxId, inbox.publicKey, 'random');
        this.sync?.addInbox(myInboxId, inboxPriv);
        row = {
          convoId, peerUserId, myInboxId, peerInboxId: null, enc: this.sealSecrets(convoId, ratchet, inboxPriv),
          pendingX3dh: init.header, verifiable, nextSeq: 0, createdAt: Date.now(),
        };
      } else {
        ({ ratchet, inboxPriv } = await this.loadSecrets(row));
      }

      const payload: AppPayload = { t: 'msg', text, inbox: row.myInboxId };
      const sealed = sealMessage(ratchet, utf8(JSON.stringify(payload)));
      if (sealed.blobBytes.length > LIMITS.CLIENT_BLOB_MAX_BYTES) throw new Error('Message is too long.');
      // Commit the advanced ratchet BEFORE any network call: a message key must never be used twice.
      const seq = row.nextSeq;
      row = { ...row, verifiable, enc: this.sealSecrets(convoId, sealed.state, inboxPriv), nextSeq: seq + 1 };
      await appDb.sessions.put(row);

      const msg: MessageRow = {
        convoId, direction: 'out', text, ts: Date.now(), status: 'Encrypted', seq, cid: '', salt: '', sig: '',
        senderUserId: this.vault.userId,
      };
      msg.id = await appDb.messages.add(msg);
      const patch = async (p: Partial<MessageRow>) => {
        Object.assign(msg, p);
        await appDb.messages.update(msg.id!, p);
        this.hooks.onChange();
      };
      this.hooks.onChange();

      try {
        const cid = await this.ipfs.add(sealed.blobBytes);
        const salt = randomBytes(32);
        const C = commitment(cid, salt);
        const sig = verifiable ? signCommitment(this.vault.ed.privateKey, C, this.vault.userId, convoId, seq) : new Uint8Array(0);
        await patch({ status: 'Uploaded', cid, salt: toB64(salt), sig: toB64(sig) });

        const ptr = sealPointer(sealed.pointerKey, sealed.header, { cid, salt: toB64(salt), sig: toB64(sig), seq, ts: Date.now() });
        const envelope: RelayEnvelope = {
          inboxId: row.peerInboxId ?? firstInboxId(peerUserId), header: sealed.header, nonce: ptr.nonce,
          sealedPointer: ptr.sealedPointer, ...(row.pendingX3dh ? { x3dh: row.pendingX3dh } : {}),
        };
        const r = await postJson(`${ENV.relayUrl}/inbox/${envelope.inboxId}/messages`, envelope);
        if (r.status !== 202) throw new Error(`relay refused the message (${r.status})`);
        await patch({ status: 'Sent' });

        if (verifiable) {
          const leaf = toHex(leafOf(C, sig));
          const lr = await postJson(`${ENV.batcherUrl}/leaf`, { commitment: toHex(C), sig: toB64(sig), senderUserId: this.vault.userId, convoId, seq });
          if (lr.status === 200) await patch({ status: 'Submitted', leaf });
          else await patch({ leaf, error: 'Not yet submitted for verification' });
        }
      } catch (e) {
        await patch({ status: 'UploadFailed', error: (e as Error).message });
      }
    });
  }

  // ---------- Flow D: receive ----------
  private async handleIncoming(inboxId: Hex, msgId: string, env: RelayEnvelope, attempt = 0): Promise<void> {
    const drop = () => this.sync?.ack(inboxId, msgId); // invalid or duplicate: remove from relay, never show
    let convoId: Hex;
    if (env.x3dh) {
      convoId = convoIdOf(this.vault.userId, userIdOf(fromB64(env.x3dh.ikA)));
    } else {
      const row = await appDb.sessions.where('myInboxId').equals(inboxId).first();
      if (!row) return drop();
      convoId = row.convoId;
    }

    await this.withLock(convoId, async () => {
      let row = await appDb.sessions.get(convoId);
      let ratchet: RatchetState;
      let inboxPriv: Uint8Array;
      let isNew = false;
      if (row) {
        ({ ratchet, inboxPriv } = await this.loadSecrets(row));
      } else {
        if (!env.x3dh) return drop();
        try {
          const resp = x3dhRespond(this.vault.ed, this.vault.spk, env.x3dh);
          ratchet = initResponder(resp.sk, this.vault.spk);
          wipe(resp.sk);
        } catch {
          return drop();
        }
        const inbox = generateInboxKeys();
        inboxPriv = inbox.privateKey;
        isNew = true;
        row = {
          convoId, peerUserId: userIdOf(fromB64(env.x3dh.ikA)), myInboxId: inboxIdOf(inbox.publicKey), peerInboxId: null,
          enc: { nonce: '', ct: '' }, pendingX3dh: null, verifiable: false, nextSeq: 0, createdAt: Date.now(),
        };
      }

      try {
        const opened = openEnvelope(ratchet, env); // state is a COPY; stored state unchanged on failure (C7)
        let blobBytes: Uint8Array;
        try {
          blobBytes = await this.ipfs.cat(opened.pointer.cid);
        } catch {
          if (attempt < 5) setTimeout(() => void this.handleIncoming(inboxId, msgId, env, attempt + 1), 10_000 * (attempt + 1));
          return; // keep it on the relay (not acked): shows nothing yet, retried later
        }
        const parsed = BlobEnvelopeSchema.safeParse(JSON.parse(fromUtf8(blobBytes)));
        if (!parsed.success) return drop();
        const plain = JSON.parse(fromUtf8(openBlob(opened.encKey, parsed.data, env.header))) as Partial<AppPayload>;
        if (plain.t !== 'msg' || typeof plain.text !== 'string') return drop();

        const peerInbox = typeof plain.inbox === 'string' && HEX32.test(plain.inbox) ? (plain.inbox as Hex) : row.peerInboxId;
        const next: SessionRow = { ...row, peerInboxId: peerInbox, pendingX3dh: null, enc: this.sealSecrets(convoId, opened.state, inboxPriv) };
        if (isNew) {
          try {
            await this.registerInbox(next.myInboxId, this.inboxPub(inboxPriv), 'random');
          } catch {
            return; // relay unreachable: leave the message queued (not acked) and process it on redelivery
          }
        }
        await appDb.sessions.put(next);
        if (isNew) this.sync?.addInbox(next.myInboxId, inboxPriv);
        if (!(await appDb.contacts.get(next.peerUserId))) {
          await appDb.contacts.put({ userId: next.peerUserId, name: next.peerUserId.slice(0, 10), bundle: null, addedAt: Date.now() });
        }
        await appDb.messages.add({
          convoId, direction: 'in', text: plain.text, ts: opened.pointer.ts, status: 'Delivered', seq: opened.pointer.seq,
          cid: opened.pointer.cid, salt: opened.pointer.salt, sig: opened.pointer.sig, senderUserId: next.peerUserId,
        });
        this.sync?.ack(inboxId, msgId);
        this.hooks.onChange();
      } catch (e) {
        void e;
        return drop(); // forged, replayed or corrupt: never shown
      }
    });
  }

  /** Ed25519 libsodium private keys are seed||publicKey, so the public half is the last 32 bytes. */
  private inboxPub = (priv: Uint8Array): Uint8Array => priv.slice(32, 64);

  // ---------- Flow E/F: proofs and verification ----------
  async pollProofs(): Promise<void> {
    const rows = (await appDb.messages.toArray()).filter((m) => m.status === 'Submitted' && m.leaf && !m.anchor);
    for (const m of rows) {
      try {
        const r = await http(`${ENV.batcherUrl}/proof/${m.leaf}`);
        const p = ProofResponseSchema.safeParse(r.body);
        if (p.success && p.data.status === 'anchored') {
          const { batchId, proof, root, txHash } = p.data;
          await appDb.messages.update(m.id!, {
            status: 'Anchored', anchor: { batchId, proof: proof as Hex[], root: root as Hex, txHash: txHash as Hex },
          });
          this.hooks.onChange();
        }
      } catch {
        /* batcher unreachable: try again on the next tick */
      }
    }
  }

  async verify(messageId: number): Promise<FlowFResult> {
    const m = await appDb.messages.get(messageId);
    if (!m) throw new Error('unknown message');
    if (!m.sig) throw new Error('This message was sent without a signature, so it cannot be verified.');
    let anchor = m.anchor;
    if (!anchor) {
      const leaf = m.leaf ?? toHex(leafOf(commitment(m.cid, fromB64(m.salt)), fromB64(m.sig)));
      const r = await http(`${ENV.batcherUrl}/proof/${leaf}`).catch(() => null);
      const p = r ? ProofResponseSchema.safeParse(r.body) : null;
      if (p?.success && p.data.status === 'anchored') {
        anchor = { batchId: p.data.batchId, proof: p.data.proof as Hex[], root: p.data.root as Hex, txHash: p.data.txHash as Hex };
      }
    }
    const ledger = this.ledgerRO();
    const result = await verifyFlowF(
      { cid: m.cid, salt: m.salt, sig: m.sig, seq: m.seq, senderUserId: m.senderUserId, convoId: m.convoId, anchor },
      {
        resolveBundle: async (id) => {
          const r = await this.resolveBundle(id);
          return r ? { bundle: r.bundle, onChainHash: r.onChainHash } : null;
        },
        getBatch: async (id) => {
          const b = await ledger.getBatch(id);
          return b ? { root: b.root, anchoredAt: b.anchoredAt } : null;
        },
        fetchBlob: (cid) => this.ipfs.cat(cid),
      },
    );
    await appDb.messages.update(messageId, {
      outcome: result.outcome, ...(anchor ? { anchor } : {}),
      status: result.outcome === 'VERIFIED' ? 'Verified' : result.outcome === 'PENDING' ? (m.direction === 'out' ? 'Submitted' : 'Delivered') : 'Invalid',
    });
    this.hooks.onChange();
    return result;
  }

  async exportProof(messageId: number): Promise<string> {
    const m = await appDb.messages.get(messageId);
    if (!m?.anchor) throw new Error('This message is not anchored yet.');
    const pkg: ProofPackage = {
      cid: m.cid, salt: m.salt, sig: m.sig, seq: m.seq, senderUserId: m.senderUserId, convoId: m.convoId,
      batchId: m.anchor.batchId, proof: m.anchor.proof, root: m.anchor.root, txHash: m.anchor.txHash,
    };
    return JSON.stringify(pkg, null, 2);
  }
}
