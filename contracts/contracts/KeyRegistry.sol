// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title KeyRegistry
/// @notice Maps a userId (keccak256 of an Ed25519 identity key) to a hash + IPFS CID of a signed key bundle.
/// @dev Stores no personal data. The first caller for a userId becomes its owner. Squatting is mitigated
///      off-chain: clients always check that the bundle's identity key hashes to userId and that the
///      prekey signature is valid, so a squatter can only cause denial of service.
contract KeyRegistry {
    struct Entry {
        address owner;
        bytes32 bundleHash;
        string bundleCid;
        uint64 version;
        uint64 updatedAt;
    }

    uint256 public constant MAX_CID_LENGTH = 128;

    mapping(bytes32 => Entry) public entries; // userId => entry

    event BundlePublished(bytes32 indexed userId, uint64 version, bytes32 bundleHash, string bundleCid);

    error NotOwner();
    error EmptyBundleHash();
    error InvalidCid();

    function publish(bytes32 userId, bytes32 bundleHash, string calldata bundleCid) external {
        if (bundleHash == bytes32(0)) revert EmptyBundleHash();
        uint256 len = bytes(bundleCid).length;
        if (len == 0 || len > MAX_CID_LENGTH) revert InvalidCid();

        Entry storage e = entries[userId];
        if (e.owner == address(0)) {
            e.owner = msg.sender;
        } else if (e.owner != msg.sender) {
            revert NotOwner();
        }
        e.bundleHash = bundleHash;
        e.bundleCid = bundleCid;
        e.version += 1;
        e.updatedAt = uint64(block.timestamp);

        emit BundlePublished(userId, e.version, bundleHash, bundleCid);
    }
}
