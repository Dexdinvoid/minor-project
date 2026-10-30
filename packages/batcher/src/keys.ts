import { fromB64, type Hex } from '@sc/shared';
import { bundleHash, verifyBundle } from '@sc/crypto';
import type { ResolvedBundle } from '@sc/ledger';

export interface KeyResolver {
  /** Ed25519 public key of a registered user, or null if unregistered / invalid. */
  getEd25519(userId: Hex): Promise<Uint8Array | null>;
}

/** Trusts nothing: bundle hash must equal the chain's hash, userId must hash from the key, prekey sig must verify. */
export function makeKeyResolver(
  resolveBundle: (userId: Hex) => Promise<ResolvedBundle | null>,
  now: () => number = Date.now,
  ttlMs = 5 * 60_000,
): KeyResolver {
  const cache = new Map<string, { key: Uint8Array; at: number }>();
  return {
    async getEd25519(userId) {
      const hit = cache.get(userId);
      if (hit && now() - hit.at < ttlMs) return hit.key;
      try {
        const r = await resolveBundle(userId);
        if (!r) return null;
        if (bundleHash(r.bundle) !== r.onChainHash.toLowerCase()) return null;
        if (!verifyBundle(r.bundle).ok || r.bundle.userId.toLowerCase() !== userId.toLowerCase()) return null;
        const key = fromB64(r.bundle.identityKeyEd25519);
        cache.set(userId, { key, at: now() });
        return key;
      } catch {
        return null; // fail closed
      }
    },
  };
}
