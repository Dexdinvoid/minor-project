import { Contract, Interface, type ContractRunner, type Provider, type Signer } from 'ethers';
import type { Hex } from '@sc/shared';
import { ANCHOR_REGISTRY_ABI, KEY_REGISTRY_ABI } from './abi';

export interface LedgerConfig {
  provider: Provider;
  signer?: Signer; // needed for publish() and anchor()
  keyRegistry: string;
  anchorRegistry: string;
  log?: (line: string) => void;
}

export interface KeyEntry {
  owner: string;
  bundleHash: Hex;
  bundleCid: string;
  version: bigint;
  updatedAt: bigint;
}

export interface BatchInfo {
  batchId: number;
  root: Hex;
  leafCount: number;
  submitter: string;
  anchoredAt: number;
}

export interface AnchorReceipt {
  batchId: number;
  txHash: Hex;
  anchoredAt: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  blockNumber: number;
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

/** Typed wrapper around both contracts (ethers v6: chain values are bigint, converted at the edge, M5). */
export class LedgerClient {
  readonly keyRegistry: Contract;
  readonly anchorRegistry: Contract;
  private anchorIface = new Interface(ANCHOR_REGISTRY_ABI);

  constructor(private cfg: LedgerConfig) {
    const runner: ContractRunner = cfg.signer ?? cfg.provider;
    this.keyRegistry = new Contract(cfg.keyRegistry, KEY_REGISTRY_ABI, runner);
    this.anchorRegistry = new Contract(cfg.anchorRegistry, ANCHOR_REGISTRY_ABI, runner);
  }

  /** Pitfall M8: print chainId and addresses at startup; fail fast if no contract code is deployed. */
  async assertDeployed(): Promise<{ chainId: bigint }> {
    const net = await this.cfg.provider.getNetwork();
    this.cfg.log?.(`ledger chainId=${net.chainId} keyRegistry=${this.cfg.keyRegistry} anchorRegistry=${this.cfg.anchorRegistry}`);
    for (const addr of [this.cfg.keyRegistry, this.cfg.anchorRegistry]) {
      const code = await this.cfg.provider.getCode(addr);
      if (code === '0x') throw new Error(`no contract code at ${addr} on chain ${net.chainId}`);
    }
    return { chainId: net.chainId };
  }

  async getKeyEntry(userId: Hex): Promise<KeyEntry | null> {
    const r = await this.keyRegistry.getFunction('entries').staticCall(userId);
    if (r.owner === ZERO_ADDR) return null;
    return {
      owner: r.owner as string,
      bundleHash: r.bundleHash as Hex,
      bundleCid: r.bundleCid as string,
      version: BigInt(r.version),
      updatedAt: BigInt(r.updatedAt),
    };
  }

  async publishBundle(userId: Hex, bundleHash: Hex, bundleCid: string): Promise<{ txHash: Hex }> {
    const tx = await this.keyRegistry.getFunction('publish')(userId, bundleHash, bundleCid);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('publish transaction failed');
    return { txHash: receipt.hash as Hex };
  }

  async batchCount(): Promise<number> {
    return Number(await this.anchorRegistry.getFunction('batchCount').staticCall());
  }

  async getBatch(batchId: number): Promise<BatchInfo | null> {
    if (batchId < 0 || batchId >= (await this.batchCount())) return null;
    const r = await this.anchorRegistry.getFunction('batches').staticCall(batchId);
    return {
      batchId,
      root: r.root as Hex,
      leafCount: Number(r.leafCount),
      submitter: r.submitter as string,
      anchoredAt: Number(r.anchoredAt),
    };
  }

  /** Anchors a root. Waits for the receipt, THEN reads the event (pitfall M7). Callers must serialise (pitfall M6). */
  async anchor(root: Hex, leafCount: number): Promise<AnchorReceipt> {
    const tx = await this.anchorRegistry.getFunction('anchor')(root, leafCount);
    const receipt = await tx.wait();
    if (!receipt || receipt.status !== 1) throw new Error('anchor transaction reverted');
    let batchId: number | null = null;
    for (const log of receipt.logs) {
      if (String(log.address).toLowerCase() !== this.cfg.anchorRegistry.toLowerCase()) continue;
      const parsed = this.anchorIface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'BatchAnchored') batchId = Number(parsed.args.getValue('batchId'));
    }
    if (batchId === null) throw new Error('BatchAnchored event not found in receipt');
    const block = await this.cfg.provider.getBlock(receipt.blockNumber);
    return {
      batchId,
      txHash: receipt.hash as Hex,
      anchoredAt: Number(block?.timestamp ?? 0),
      gasUsed: receipt.gasUsed as bigint,
      effectiveGasPrice: (receipt.gasPrice ?? 0n) as bigint,
      blockNumber: receipt.blockNumber as number,
    };
  }

  async verifyLeafOnChain(batchId: number, leaf: Hex, proof: Hex[]): Promise<boolean> {
    return (await this.anchorRegistry.getFunction('verifyLeaf').staticCall(batchId, leaf, proof)) as boolean;
  }
}
