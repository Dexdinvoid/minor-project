import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { initCrypto } from '@sc/crypto';
import { KuboPinStore } from '@sc/ipfs/node';
import { loadConfig } from './config';
import { buildRelay } from './server';

async function main() {
  loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
  await initCrypto(); // pitfall C1
  const cfg = loadConfig();
  mkdirSync(dirname(cfg.dbPath), { recursive: true });
  const relay = await buildRelay(cfg, new KuboPinStore(cfg.kuboRpcUrl));
  await relay.app.listen({ port: cfg.port, host: cfg.host });
  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('relay failed to start:', (e as Error).message);
  process.exit(1);
});
