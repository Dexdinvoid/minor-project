// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title AnchorRegistry
/// @notice Stores Merkle roots of message-commitment batches. Anyone may anchor; trust comes from clients
///         verifying leaf signatures and proofs, not from who submitted a root.
contract AnchorRegistry {
    struct Batch {
        bytes32 root;
        uint32 leafCount;
        address submitter;
        uint64 anchoredAt;
    }

    Batch[] public batches;

    event BatchAnchored(uint256 indexed batchId, bytes32 root, uint32 leafCount, address submitter);

    error EmptyRoot();
    error ZeroLeaves();

    function anchor(bytes32 root, uint32 leafCount) external returns (uint256 batchId) {
        if (root == bytes32(0)) revert EmptyRoot();
        if (leafCount == 0) revert ZeroLeaves();
        batchId = batches.length;
        batches.push(Batch(root, leafCount, msg.sender, uint64(block.timestamp)));
        emit BatchAnchored(batchId, root, leafCount, msg.sender);
    }

    function batchCount() external view returns (uint256) {
        return batches.length;
    }

    /// @dev OpenZeppelin MerkleProof uses sorted pairs; the off-chain tree must use sortPairs: true.
    function verifyLeaf(uint256 batchId, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        if (batchId >= batches.length) return false;
        return MerkleProof.verifyCalldata(proof, batches[batchId].root, leaf);
    }
}
