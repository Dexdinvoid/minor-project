import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { z } from 'zod';
import { randomBytes } from '@sc/crypto';
import { toHex, type Hex } from '@sc/shared';
import { InboxRegisterSchema, RelayEnvelopeSchema } from '@sc/shared/schemas';
import type { PinStore } from '@sc/ipfs';
import type { RelayConfig } from './config';
import { RelayDb } from './db';
import { FailureTracker } from './limits';
import { inboxBindingValid, sigFingerprint, verifyChallengeSig, verifyRestSig } from './auth';

const CID_RE = /^[a-z0-9]{40,120}$/;
const INBOX_RE = /^0x[0-9a-f]{64}$/;

const ClientFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('HELLO'), inboxId: z.string().regex(INBOX_RE) }),
  z.object({ type: z.literal('AUTH'), inboxId: z.string().regex(INBOX_RE), sig: z.string().max(200) }),
  z.object({ type: z.literal('ACK'), inboxId: z.string().regex(INBOX_RE), msgId: z.string().max(64) }),
]);

interface SocketState {
  ip: string;
  pending: Map<string, string>; // inboxId -> nonce hex awaiting AUTH
  authed: Set<string>;
  frames: number[];
}

export interface Relay {
  app: FastifyInstance;
  db: RelayDb;
  close(): Promise<void>;
  /** TTL cleanup, exposed for tests and for the hourly timer. */
  purge(): { messages: number };
}

/** Log only the first 8 hex chars of inbox ids; never nonces, signatures or contents (design section 14, item 5). */
const redactUrl = (u: string): string => u.replace(/(0x[0-9a-f]{8})[0-9a-f]{56}/g, '$1…').split('?')[0]!;

export async function buildRelay(cfg: RelayConfig, pins: PinStore, db = new RelayDb(cfg.dbPath)): Promise<Relay> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers["x-inbox-sig"]', 'req.headers.authorization', 'req.headers.cookie'],
      serializers: {
        req: (r: FastifyRequest) => ({ method: r.method, url: redactUrl(r.url) }),
      },
    },
    bodyLimit: cfg.blobMaxBytes,
    trustProxy: cfg.trustProxy,
  });

  await app.register(helmet);
  await app.register(cors, {
    origin: cfg.clientOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'x-timestamp', 'x-inbox-sig'],
  });
  await app.register(rateLimit, { max: cfg.reqPerMinPerIp, timeWindow: '1 minute' });

  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: cfg.blobMaxBytes }, (_req, body, done) =>
    done(null, body),
  );

  // Never leak internals (checklist: error messages avoid leaking internals).
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ code: (err as { code?: string }).code }, 'request failed');
    const code = status === 413 ? 'too_large' : status === 429 ? 'rate_limited' : status < 500 ? 'bad_request' : 'internal';
    void reply.status(status >= 400 && status < 600 ? status : 500).send({ error: code });
  });

  const ipFailures = new FailureTracker(cfg.failedAuthPerMinPerIp);
  const inboxFailures = new FailureTracker(cfg.failedAuthPerMinPerIp * 4);

  // ---------- live delivery hub ----------
  const subscribers = new Map<string, Set<WebSocket>>();
  const push = (inboxId: string, msgId: string, bytes: Buffer) => {
    const set = subscribers.get(inboxId);
    if (!set) return;
    const frame = JSON.stringify({ type: 'MSG', inboxId, msgId, envelope: JSON.parse(bytes.toString('utf8')) });
    for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(frame);
  };

  // ---------- REST ----------
  app.get('/health', async () => ({ ok: true, time: cfg.now() }));

  app.put('/inbox', async (req, reply) => {
    const parsed = InboxRegisterSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'bad_request' });
    const { inboxId, inboxPub, kind } = parsed.data;
    if (!inboxBindingValid(inboxId as Hex, inboxPub, kind)) return reply.status(400).send({ error: 'binding_invalid' });
    const res = db.registerInbox({ inboxId, inboxPub, kind, createdAt: cfg.now() });
    if (res === 'conflict') return reply.status(409).send({ error: 'conflict' });
    return reply.status(res === 'created' ? 201 : 200).send({ ok: true });
  });

  app.post<{ Params: { id: string } }>('/inbox/:id/messages', { bodyLimit: cfg.envelopeMaxBytes }, async (req, reply) => {
    const { id } = req.params;
    if (!INBOX_RE.test(id)) return reply.status(400).send({ error: 'bad_request' });
    const parsed = RelayEnvelopeSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.inboxId !== id) return reply.status(400).send({ error: 'bad_request' });
    if (!db.getInbox(id)) return reply.status(404).send({ error: 'unknown_inbox' });
    const bytes = Buffer.from(JSON.stringify(parsed.data), 'utf8');
    if (bytes.length > cfg.envelopeMaxBytes) return reply.status(413).send({ error: 'too_large' });
    const msgId = toHex(randomBytes(16)).slice(2);
    if (!db.enqueue({ msgId, inboxId: id, bytes, receivedAt: cfg.now() }, cfg.pendingPerInbox)) {
      return reply.status(429).send({ error: 'inbox_full' });
    }
    push(id, msgId, bytes);
    return reply.status(202).send({ msgId });
  });

  /** REST authentication fallback: X-Timestamp + X-Inbox-Sig over (method, path, timestamp, bodyHash). */
  function restAuth(req: FastifyRequest, inboxId: string): { ok: true } | { ok: false; status: number; body: object } {
    const now = cfg.now();
    const fail = (status: number, error: string) => {
      ipFailures.record(req.ip, now);
      return { ok: false as const, status, body: { error, serverTime: now } }; // S9: return server time
    };
    if (ipFailures.blocked(req.ip, now) || inboxFailures.blocked(inboxId, now)) {
      return { ok: false, status: 429, body: { error: 'rate_limited' } };
    }
    const inbox = db.getInbox(inboxId);
    const ts = Number(req.headers['x-timestamp']);
    const sig = req.headers['x-inbox-sig'];
    if (!inbox || !Number.isFinite(ts) || typeof sig !== 'string') {
      inboxFailures.record(inboxId, now);
      return fail(401, 'unauthorized');
    }
    if (Math.abs(now - ts) > cfg.restWindowMs) return fail(401, 'timestamp_out_of_window');
    const body = new Uint8Array(0); // GET/DELETE have no body
    if (!verifyRestSig(inbox, req.method, req.url, ts, body, sig)) {
      inboxFailures.record(inboxId, now);
      return fail(401, 'unauthorized');
    }
    if (!db.rememberRestSig(sigFingerprint(sig), now)) return fail(401, 'replayed');
    return { ok: true };
  }

  app.get<{ Params: { id: string } }>('/inbox/:id/messages', async (req, reply) => {
    if (!INBOX_RE.test(req.params.id)) return reply.status(400).send({ error: 'bad_request' });
    const auth = restAuth(req, req.params.id);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);
    const rows = db.listMessages(req.params.id);
    return { messages: rows.map((r) => ({ msgId: r.msgId, envelope: JSON.parse(r.bytes.toString('utf8')) })) };
  });

  app.delete<{ Params: { id: string; msgId: string } }>('/inbox/:id/messages/:msgId', async (req, reply) => {
    if (!INBOX_RE.test(req.params.id)) return reply.status(400).send({ error: 'bad_request' });
    const auth = restAuth(req, req.params.id);
    if (!auth.ok) return reply.status(auth.status).send(auth.body);
    return { deleted: db.ack(req.params.id, req.params.msgId) };
  });

  // ---------- pin gateway ----------
  app.post('/blob', async (req, reply) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.status(400).send({ error: 'bad_request' });
    if (body.length > cfg.blobMaxBytes) return reply.status(413).send({ error: 'too_large' });
    const cid = await pins.add(new Uint8Array(body));
    return { cid };
  });

  app.get<{ Params: { cid: string } }>('/blob/:cid', async (req, reply) => {
    if (!CID_RE.test(req.params.cid)) return reply.status(400).send({ error: 'bad_request' });
    const bytes = await pins.cat(req.params.cid);
    if (!bytes) return reply.status(404).send({ error: 'not_found' });
    return reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'public, max-age=31536000, immutable') // content-addressed
      .send(Buffer.from(bytes));
  });

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  app.server.on('upgrade', (req, socket, head) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const now = cfg.now();
    const origin = req.headers.origin;
    if (!req.url?.startsWith('/ws') || (origin && origin !== cfg.clientOrigin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      return socket.destroy();
    }
    if (ipFailures.blocked(ip, now)) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => onSocket(ws, ip));
  });

  function onSocket(ws: WebSocket, ip: string): void {
    const st: SocketState = { ip, pending: new Map(), authed: new Set(), frames: [] };
    const send = (o: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(o));
    const err = (code: number, message: string, close = false) => {
      send({ type: 'ERROR', code, message });
      if (close) ws.close(4000 + code);
    };

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const now = cfg.now();
      st.frames = st.frames.filter((t) => now - t < 10_000);
      st.frames.push(now);
      if (isBinary || st.frames.length > 100) return err(429, 'rate_limited', true);

      let frame: z.infer<typeof ClientFrame>;
      try {
        const p = ClientFrame.safeParse(JSON.parse(data.toString('utf8')));
        if (!p.success) return err(400, 'bad_frame');
        frame = p.data;
      } catch {
        return err(400, 'bad_frame');
      }

      if (frame.type === 'HELLO') {
        if (ipFailures.blocked(ip, now)) return err(429, 'rate_limited', true);
        if (st.pending.size + st.authed.size >= 32) return err(400, 'too_many_inboxes');
        if (!db.getInbox(frame.inboxId)) return err(404, 'unknown_inbox');
        const nonce = toHex(randomBytes(32));
        db.createChallenge(nonce, frame.inboxId, now + cfg.challengeTtlMs);
        st.pending.set(frame.inboxId, nonce);
        return send({ type: 'CHALLENGE', inboxId: frame.inboxId, nonce });
      }

      if (frame.type === 'AUTH') {
        const nonce = st.pending.get(frame.inboxId);
        st.pending.delete(frame.inboxId); // a challenge can be answered once, win or lose
        const inbox = db.getInbox(frame.inboxId);
        const valid =
          nonce !== undefined &&
          inbox !== undefined &&
          db.consumeChallenge(nonce, frame.inboxId, now) &&
          verifyChallengeSig(inbox, nonce as Hex, frame.sig);
        if (!valid) {
          ipFailures.record(ip, now);
          inboxFailures.record(frame.inboxId, now);
          return err(401, 'unauthorized', true);
        }
        st.authed.add(frame.inboxId);
        let set = subscribers.get(frame.inboxId);
        if (!set) subscribers.set(frame.inboxId, (set = new Set()));
        set.add(ws);
        send({ type: 'OK', inboxId: frame.inboxId });
        for (const m of db.listMessages(frame.inboxId)) push(frame.inboxId, m.msgId, m.bytes); // offline delivery
        return;
      }

      if (frame.type === 'ACK') {
        if (!st.authed.has(frame.inboxId)) return err(401, 'unauthorized');
        db.ack(frame.inboxId, frame.msgId);
      }
    });

    ws.on('close', () => {
      for (const id of st.authed) subscribers.get(id)?.delete(ws);
    });
    ws.on('error', () => ws.close());
  }

  const purge = () => db.purge(cfg.now(), cfg.messageTtlMs, cfg.restWindowMs);
  const timer = setInterval(purge, 60 * 60 * 1000);
  timer.unref();

  return {
    app,
    db,
    purge,
    async close() {
      clearInterval(timer);
      for (const c of wss.clients) c.terminate();
      wss.close();
      await app.close();
      db.close();
    },
  };
}
