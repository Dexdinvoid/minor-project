/**
 * Independent verifier for exported proof packages.
 *   pnpm auditor proof-12.json
 * Needs only: the proof file, a chain RPC, the two contract addresses and any pin gateway.
 * It does NOT trust the batcher, the relay or the client UI (SYSTEM_DESIGN section 8 / Flow F).
 */
import { readFileSync } from 'node:fs';
import { JsonRpcProvider } from 'ethers';
import { initCrypto } from '@sc/crypto';
import { IpfsClient } from '@sc/ipfs';
import { LedgerClient, makeBundleResolver, verifyFlowF } from '@sc/ledger';
import { ProofPackageSchema } from '@sc/shared/schemas';

const need = (n: string): string => {
  const v = process.env[n];
  if (!v) {
    console.error(`missing env ${n} (see .env.example)`);
    process.exit(2);
  }
  return v;
};

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: pnpm auditor <proof.json>');
    process.exit(2);
  }
  await initCrypto();
  const parsed = ProofPackageSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    console.error('not a valid proof package:', parsed.error.issues.map((i) => i.path.join('.')).join(', '));
    process.exit(2);
  }
  const p = parsed.data;
  const ledger = new LedgerClient({
    provider: new JsonRpcProvider(need('CHAIN_RPC_URL')),
    keyRegistry: need('KEY_REGISTRY_ADDRESS'),
    anchorRegistry: need('ANCHOR_REGISTRY_ADDRESS'),
  });
  const ipfs = new IpfsClient({ gateways: [process.env.RELAY_URL ?? 'http://127.0.0.1:4000'] });
  const resolve = makeBundleResolver({ getKeyEntry: (id) => ledger.getKeyEntry(id), fetchBlob: (c) => ipfs.cat(c) });

  const res = await verifyFlowF(
    { cid: p.cid, salt: p.salt, sig: p.sig, seq: p.seq, senderUserId: p.senderUserId as `0x${string}`, convoId: p.convoId as `0x${string}`,
      anchor: { batchId: p.batchId, proof: p.proof as `0x${string}`[], root: p.root as `0x${string}`, txHash: p.txHash as `0x${string}` } },
    {
      resolveBundle: async (id) => {
        const r = await resolve(id);
        return r ? { bundle: r.bundle, onChainHash: r.onChainHash } : null;
      },
      getBatch: async (id) => {
        const b = await ledger.getBatch(id);
        return b ? { root: b.root, anchoredAt: b.anchoredAt } : null;
      },
      fetchBlob: (cid) => ipfs.cat(cid),
    },
  );
  for (const s of res.steps) console.warn(`${s.status === 'pass' ? 'PASS' : s.status === 'fail' ? 'FAIL' : 'SKIP'}  ${s.label}${s.detail ? ` (${s.detail})` : ''}`);
  console.warn(`\nRESULT: ${res.outcome}${res.anchoredAt ? ` (anchored ${new Date(res.anchoredAt * 1000).toISOString()})` : ''}`);
  process.exit(res.outcome === 'VERIFIED' ? 0 : 1);
}

main().catch((e) => {
  console.error('auditor error:', (e as Error).message);
  process.exit(2);
});
