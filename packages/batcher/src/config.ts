import { LIMITS } from '@sc/shared';

export interface BatcherConfig {
  port: number;
  host: string;
  dbPath: string;
  clientOrigin: string;
  flushAtLeaves: number; // flush when queue >= this
  flushAfterMs: number; // or when the oldest leaf is this old
  maxBatch: number; // hard cap per tree
  tickMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  devFaucet: boolean;
  devFaucetAmountEth: string;
  now: () => number;
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, o: Partial<BatcherConfig> = {}): BatcherConfig {
  return {
    port: int(env.BATCHER_PORT, 4100),
    host: env.BATCHER_HOST ?? '0.0.0.0',
    dbPath: env.BATCHER_DB_PATH ?? './data/batcher.db',
    clientOrigin: env.CLIENT_ORIGIN ?? 'http://localhost:5173',
    flushAtLeaves: int(env.BATCH_MAX_LEAVES, LIMITS.BATCH_MAX_LEAVES),
    flushAfterMs: int(env.BATCH_MAX_AGE_MS, LIMITS.BATCH_MAX_AGE_MS),
    maxBatch: LIMITS.BATCH_HARD_MAX,
    tickMs: 5000,
    backoffBaseMs: 2000,
    backoffMaxMs: 120_000,
    devFaucet: env.DEV_FAUCET === 'true',
    devFaucetAmountEth: env.DEV_FAUCET_AMOUNT_ETH ?? '1',
    now: () => Date.now(),
    ...o,
  };
}
