// Human-readable ABIs. They must match contracts/*.sol exactly (checked by scripts/check-abi.ts).
export const KEY_REGISTRY_ABI = [
  'function entries(bytes32 userId) view returns (address owner, bytes32 bundleHash, string bundleCid, uint64 version, uint64 updatedAt)',
  'function publish(bytes32 userId, bytes32 bundleHash, string bundleCid)',
  'event BundlePublished(bytes32 indexed userId, uint64 version, bytes32 bundleHash, string bundleCid)',
] as const;

export const ANCHOR_REGISTRY_ABI = [
  'function batches(uint256) view returns (bytes32 root, uint32 leafCount, address submitter, uint64 anchoredAt)',
  'function batchCount() view returns (uint256)',
  'function anchor(bytes32 root, uint32 leafCount) returns (uint256 batchId)',
  'function verifyLeaf(uint256 batchId, bytes32 leaf, bytes32[] proof) view returns (bool)',
  'event BatchAnchored(uint256 indexed batchId, bytes32 root, uint32 leafCount, address submitter)',
] as const;
