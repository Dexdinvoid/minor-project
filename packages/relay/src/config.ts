import { LIMITS } from '@sc/shared';

export interface RelayConfig {
  port: number;
  host: string;
  dbPath: string;
  kuboRpcUrl: string;
  clientOrigin: string;
  envelopeMaxBytes: number;
  blobMaxBytes: number;
  pendingPerInbox: number;
  reqPerMinPerIp: number;
  failedAuthPerMinPerIp: number;
  messageTtlMs: number;
  challengeTtlMs: number;
  restWindowMs: number;
  trustProxy: boolean;
  /** Injectable clock for tests. */
  now: () => number;
}

const int = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    port: int(env.RELAY_PORT, 4000),
    host: env.RELAY_HOST ?? '0.0.0.0',
    dbPath: env.RELAY_DB_PATH ?? './data/relay.db',
    kuboRpcUrl: env.KUBO_RPC_URL ?? 'http://127.0.0.1:5001',
    clientOrigin: env.CLIENT_ORIGIN ?? 'http://localhost:5173',
    envelopeMaxBytes: LIMITS.ENVELOPE_MAX_BYTES,
    blobMaxBytes: LIMITS.BLOB_MAX_BYTES,
    pendingPerInbox: LIMITS.PENDING_PER_INBOX,
    reqPerMinPerIp: LIMITS.REQ_PER_MIN_PER_IP,
    failedAuthPerMinPerIp: LIMITS.FAILED_AUTH_PER_MIN_PER_IP,
    messageTtlMs: LIMITS.MESSAGE_TTL_MS,
    challengeTtlMs: LIMITS.CHALLENGE_TTL_MS,
    restWindowMs: LIMITS.REST_TIMESTAMP_WINDOW_MS,
    trustProxy: env.TRUST_PROXY === 'true',
    now: () => Date.now(),
    ...overrides,
  };
}
