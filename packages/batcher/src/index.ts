import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { initCrypto } from '@sc/crypto';
import { IpfsClient } from '@sc/ipfs';
import { LedgerClient, makeBundleResolver } from '@sc/ledger';
import { LedgerAnchorer } from './anchor';
import { loadConfig } from './config';
import { makeKeyResolver } from './keys';
import { buildBatcher } from './server';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main() {
  loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });
  await initCrypto();
  const cfg = loadConfig();
  mkdirSync(dirname(cfg.dbPath), { recursive: true });

  const provider = new JsonRpcProvider(need('CHAIN_RPC_URL'));
  const wallet = new Wallet(need('BATCHER_PRIVATE_KEY'), provider);
  const ledger = new LedgerClient({
    provider, signer: wallet,
    keyRegistry: need('KEY_REGISTRY_ADDRESS'), anchorRegistry: need('ANCHOR_REGISTRY_ADDRESS'),
    log: (l) => console.warn(l), // startup line prints chainId + addresses (pitfall M8)
  });
  await ledger.assertDeployed();

  const ipfs = new IpfsClient({ gateways: [process.env.RELAY_URL ?? 'http://127.0.0.1:4000'] });
  const resolveBundle = makeBundleResolver({
    getKeyEntry: (id) => ledger.getKeyEntry(id),
    fetchBlob: (cid) => ipfs.cat(cid),
  });

  const batcher = await buildBatcher(cfg, {
    anchorer: new LedgerAnchorer(ledger),
    keys: makeKeyResolver(resolveBundle),
    faucet: async (to, eth) => {
      const tx = await wallet.sendTransaction({ to, value: parseEther(eth) });
      await tx.wait();
      return tx.hash;
    },
  });
  await batcher.app.listen({ port: cfg.port, host: cfg.host });
  batcher.start();
  const stop = async () => { await batcher.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error('batcher failed to start:', (e as Error).message);
  process.exit(1);
});
