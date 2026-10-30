import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from 'multiformats/hashes/sha2';
import { LIMITS } from '@sc/shared';

/**
 * CIDv1, raw codec, sha2-256. This is exactly what Kubo produces for `add --cid-version=1 --raw-leaves`
 * when the content fits in ONE chunk (default chunker = 256 KiB). The client caps blobs at
 * LIMITS.CLIENT_BLOB_MAX_BYTES so local recomputation is exact (pitfall S4, docs/DECISIONS.md D-004).
 */
export async function computeCid(bytes: Uint8Array): Promise<string> {
  if (bytes.length > LIMITS.CLIENT_BLOB_MAX_BYTES) throw new Error('blob exceeds single-block size');
  const digest = await sha256.digest(bytes);
  return CID.createV1(raw.code, digest).toString();
}
