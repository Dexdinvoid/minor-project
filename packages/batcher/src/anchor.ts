import type { Hex } from '@sc/shared';
import type { LedgerClient } from '@sc/ledger';

export interface AnchorResult {
  batchId: number;
  txHash: Hex;
  anchoredAt: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface Anchorer {
  anchor(root: Hex, leafCount: number): Promise<AnchorResult>;
}

/** Serialises every transaction through one promise chain: one wallet, one nonce stream (pitfall M6). */
export class LedgerAnchorer implements Anchorer {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private ledger: LedgerClient) {}

  anchor(root: Hex, leafCount: number): Promise<AnchorResult> {
    const run = this.chain.then(() => this.ledger.anchor(root, leafCount));
    this.chain = run.catch(() => undefined);
    return run;
  }
}
