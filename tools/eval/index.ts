/**
 * Evaluation harness (SYSTEM_DESIGN section 12). Writes metrics.csv.
 *  - Always: crypto latency (seal/open) and Merkle build/prove/verify cost vs batch size.
 *  - If the batcher is running: on-chain gas and cost-per-message per batch (GET /metrics).
 * End-to-end p50/p95 latency needs the full stack; run the client against `pnpm stack:up` and use the
 * IpfsClient onTiming hook (see docs/DECISIONS.md D-009).
 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  generateIdentity, initCrypto, initInitiator, initResponder, keccak256, merkleProof, merkleRoot, openBlob,
  openEnvelope, sealMessage, sealPointer, sortLeaves, verifyMerkleProof, x3dhInitiate, x3dhRespond,
} from '@sc/crypto';
import { toB64, utf8 } from '@sc/shared';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const rows: string[] = ['metric,param,p50,p95,unit'];
const add = (m: string, p: string | number, xs: number[], unit: string) => rows.push(`${m},${p},${pct(xs, 50).toFixed(3)},${pct(xs, 95).toFixed(3)},${unit}`);

async function main() {
  await initCrypto();
  const runs = Number(process.env.EVAL_RUNS ?? 50);

  for (const size of [1_000, 10_000, 100_000]) {
    const enc: number[] = [];
    const dec: number[] = [];
    for (let i = 0; i < runs; i++) {
      const a = generateIdentity();
      const b = generateIdentity();
      const init = x3dhInitiate(a.ed, b.bundle);
      const resp = x3dhRespond(b.ed, b.spk, init.header);
      const sa = initInitiator(init.sk, init.theirSpk);
      const sb = initResponder(resp.sk, b.spk);
      const pt = utf8('x'.repeat(size));
      let t = performance.now();
      const m = sealMessage(sa, pt);
      const p = sealPointer(m.pointerKey, m.header, { cid: 'bafkrei' + 'a'.repeat(52), salt: toB64(new Uint8Array(32)), sig: '', seq: 0, ts: 0 });
      enc.push(performance.now() - t);
      t = performance.now();
      const o = openEnvelope(sb, { inboxId: `0x${'11'.repeat(32)}`, header: m.header, nonce: p.nonce, sealedPointer: p.sealedPointer });
      openBlob(o.encKey, m.blob, m.header);
      dec.push(performance.now() - t);
    }
    add('encrypt_ms', size, enc, 'ms');
    add('decrypt_ms', size, dec, 'ms');
  }

  for (const n of [1, 16, 64, 256]) {
    const leaves = sortLeaves(Array.from({ length: n }, (_, i) => keccak256(utf8(`leaf-${i}`))));
    const build: number[] = [];
    const ver: number[] = [];
    let proofBytes = 0;
    for (let r = 0; r < runs; r++) {
      let t = performance.now();
      const root = merkleRoot(leaves);
      const proof = merkleProof(leaves, r % n);
      build.push(performance.now() - t);
      proofBytes = proof.length * 32;
      t = performance.now();
      if (!verifyMerkleProof(leaves[r % n]!, proof, root)) throw new Error('self-check failed');
      ver.push(performance.now() - t);
    }
    add('merkle_build_and_prove_ms', n, build, 'ms');
    add('merkle_verify_ms', n, ver, 'ms');
    rows.push(`proof_bytes,${n},${proofBytes},${proofBytes},bytes`);
  }

  const batcher = process.env.BATCHER_URL ?? 'http://127.0.0.1:4100';
  try {
    const res = await fetch(`${batcher}/metrics`, { signal: AbortSignal.timeout(2000) });
    const { batches } = (await res.json()) as { batches: { leafCount: number; gasUsed: string; gasPrice: string }[] };
    for (const b of batches) {
      const wei = BigInt(b.gasUsed) * BigInt(b.gasPrice);
      rows.push(`gas_per_batch,${b.leafCount},${b.gasUsed},${b.gasUsed},gas`);
      rows.push(`gas_per_message,${b.leafCount},${Math.round(Number(b.gasUsed) / b.leafCount)},${Math.round(Number(b.gasUsed) / b.leafCount)},gas`);
      rows.push(`wei_per_message,${b.leafCount},${wei / BigInt(b.leafCount)},${wei / BigInt(b.leafCount)},wei`);
    }
  } catch {
    console.warn('batcher not reachable: skipping on-chain cost metrics');
  }

  writeFileSync('metrics.csv', rows.join('\n') + '\n');
  console.warn(rows.join('\n'));
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
