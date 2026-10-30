import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { commitment as _unused, leafOf, verifyCommitmentSig } from '@sc/crypto';
import { fromB64, fromHex, toHex, type Hex } from '@sc/shared';
import { LeafRequestSchema } from '@sc/shared/schemas';
import type { Anchorer } from './anchor';
import type { BatcherConfig } from './config';
import { BatcherDb } from './db';
import type { KeyResolver } from './keys';
import { buildTree } from './tree';

void _unused;

export interface FaucetFn {
  (address: string, amountEth: string): Promise<string>;
}

export interface Batcher {
  app: FastifyInstance;
  db: BatcherDb;
  /** One flush attempt. Returns the number of leaves anchored (0 if nothing was due or anchoring failed). */
  flushOnce(): Promise<number>;
  start(): void;
  close(): Promise<void>;
}

export async function buildBatcher(
  cfg: BatcherConfig,
  deps: { anchorer: Anchorer; keys: KeyResolver; faucet?: FaucetFn },
  db = new BatcherDb(cfg.dbPath),
): Promise<Batcher> {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    bodyLimit: 16 * 1024,
  });
  await app.register(helmet);
  await app.register(cors, { origin: cfg.clientOrigin, methods: ['GET', 'POST', 'OPTIONS'] });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.setErrorHandler((err, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    void reply.status(status).send({ error: status >= 500 ? 'internal' : 'bad_request' });
  });

  // ---- Flow E: POST /leaf ----
  app.post('/leaf', async (req, reply) => {
    const p = LeafRequestSchema.safeParse(req.body);
    if (!p.success) return reply.status(400).send({ error: 'bad_request' });
    const { commitment, sig, senderUserId, convoId, seq } = p.data;

    const pub = await deps.keys.getEd25519(senderUserId as Hex);
    if (!pub) return reply.status(403).send({ error: 'unknown_sender' });

    const C = fromHex(commitment);
    const sigBytes = fromB64(sig);
    if (!verifyCommitmentSig(pub, sigBytes, C, senderUserId as Hex, convoId as Hex, seq)) {
      return reply.status(400).send({ error: 'bad_signature' });
    }
    const leaf = toHex(leafOf(C, sigBytes));

    const existing = db.findBySeq(senderUserId, convoId, seq);
    if (existing) {
      // Same signed message re-submitted (client retry) is idempotent; a DIFFERENT message for the same seq is a replay/fork.
      if (existing.leaf === leaf) return { leaf, status: existing.status };
      return reply.status(409).send({ error: 'seq_already_used' });
    }
    db.insertLeaf({ leaf: leaf as Hex, commitment: commitment as Hex, sig, senderUserId: senderUserId as Hex, convoId: convoId as Hex, seq, createdAt: cfg.now() });
    return { leaf, status: 'pending' as const };
  });

  app.get<{ Params: { leaf: string } }>('/proof/:leaf', async (req, reply) => {
    if (!/^0x[0-9a-f]{64}$/.test(req.params.leaf)) return reply.status(400).send({ error: 'bad_request' });
    const row = db.getLeaf(req.params.leaf);
    if (!row) return reply.status(404).send({ error: 'unknown_leaf' });
    if (row.status === 'pending' || row.batchId === null) return { status: 'pending' as const };
    const batch = db.getBatch(row.batchId)!;
    return {
      status: 'anchored' as const,
      batchId: batch.batchId,
      root: batch.root,
      proof: JSON.parse(row.proof ?? '[]') as Hex[],
      txHash: batch.txHash,
      anchoredAt: batch.anchoredAt,
    };
  });

  app.get('/health', async () => ({ queue: db.pendingCount(), lastAnchorAt: db.lastAnchorAt() }));

  /** Gas per batch, for tools/eval (cost per message = gasUsed * gasPrice / leafCount). */
  app.get('/metrics', async () => ({ batches: db.allBatches() }));

  if (cfg.devFaucet && deps.faucet) {
    const last = new Map<string, number>();
    app.post('/dev/faucet', async (req, reply) => {
      const addr = (req.body as { address?: unknown } | null)?.address;
      if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return reply.status(400).send({ error: 'bad_request' });
      const key = addr.toLowerCase();
      if (cfg.now() - (last.get(key) ?? 0) < 10 * 60_000) return reply.status(429).send({ error: 'rate_limited' });
      last.set(key, cfg.now());
      return { txHash: await deps.faucet!(addr, cfg.devFaucetAmountEth) };
    });
  }

  // ---- Flush loop ----
  let flushing = false;
  let failures = 0;
  let nextAttemptAt = 0;

  async function flushOnce(): Promise<number> {
    if (flushing) return 0; // ticks never overlap
    const now = cfg.now();
    if (now < nextAttemptAt) return 0;
    const queue = db.pending(cfg.maxBatch);
    if (queue.length === 0) return 0;
    const due = queue.length >= cfg.flushAtLeaves || now - queue[0]!.createdAt >= cfg.flushAfterMs;
    if (!due) return 0;

    flushing = true;
    try {
      const leaves = queue.map((q) => q.leaf);
      const { root, proofs } = buildTree(leaves);
      const res = await deps.anchorer.anchor(root, leaves.length);
      db.commitBatch(
        {
          batchId: res.batchId, root, txHash: res.txHash, anchoredAt: res.anchoredAt, leafCount: leaves.length,
          gasUsed: res.gasUsed.toString(), gasPrice: res.effectiveGasPrice.toString(),
        },
        proofs,
      );
      failures = 0;
      return leaves.length;
    } catch (e) {
      // Leaves stay pending; retry with exponential backoff and a loud log line (Flow E13).
      failures += 1;
      nextAttemptAt = cfg.now() + Math.min(cfg.backoffBaseMs * 2 ** (failures - 1), cfg.backoffMaxMs);
      app.log.error({ failures, err: (e as Error).message }, 'ANCHOR FAILED: leaves remain pending');
      return 0;
    } finally {
      flushing = false;
    }
  }

  let timer: NodeJS.Timeout | undefined;
  return {
    app,
    db,
    flushOnce,
    start() {
      timer = setInterval(() => void flushOnce(), cfg.tickMs);
    },
    async close() {
      if (timer) clearInterval(timer);
      await app.close();
      db.close();
    },
  };
}
