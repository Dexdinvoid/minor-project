import { KeyBundleSchema } from '@sc/shared/schemas';
import { utf8, fromUtf8, type Hex, type KeyBundle } from '@sc/shared';

export interface ResolvedBundle {
  bundle: KeyBundle;
  onChainHash: Hex;
  version: bigint;
}

export interface BundleResolverDeps {
  getKeyEntry(userId: Hex): Promise<{ bundleHash: Hex; bundleCid: string; version: bigint } | null>;
  fetchBlob(cid: string): Promise<Uint8Array>;
}

/**
 * KeyRegistry -> IPFS. All JSON read from IPFS is validated with zod at this boundary.
 * The hash check against the chain happens in Flow B (client) and Flow F (verify); the resolver only fetches.
 */
export function makeBundleResolver(deps: BundleResolverDeps) {
  return async function resolve(userId: Hex): Promise<ResolvedBundle | null> {
    const entry = await deps.getKeyEntry(userId);
    if (!entry) return null;
    const bytes = await deps.fetchBlob(entry.bundleCid);
    let json: unknown;
    try {
      json = JSON.parse(fromUtf8(bytes));
    } catch {
      throw new Error('bundle is not valid JSON');
    }
    const parsed = KeyBundleSchema.safeParse(json);
    if (!parsed.success) throw new Error('bundle failed schema validation');
    return { bundle: parsed.data, onChainHash: entry.bundleHash, version: entry.version };
  };
}

export const bundleToBytes = (b: KeyBundle): Uint8Array => utf8(JSON.stringify(b));
