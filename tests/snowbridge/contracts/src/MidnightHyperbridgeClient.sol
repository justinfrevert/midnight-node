// This file is part of midnight-node.
// Copyright (C) Midnight Foundation
// SPDX-License-Identifier: Apache-2.0
// Licensed under the Apache License, Version 2.0 (the "License");
// You may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

pragma solidity 0.8.34;

import {SP1Beefy} from "hyperbridge/consensus/SP1Beefy.sol";
import {
    BeefyConsensusState,
    MiniCommitment,
    PartialBeefyMmrLeaf,
    ParachainHeader
} from "hyperbridge/consensus/Types.sol";
import {Codec} from "hyperbridge/consensus/Codec.sol";

/// Stores tip leaves authenticated by the unchanged Hyperbridge consensus client.
contract MidnightHyperbridgeClient {
    SP1Beefy public immutable consensus;
    bytes32 public immutable genesisHash;
    bytes public consensusState;
    uint32 public latestBeefyBlock;
    bytes32 public latestLeafHash;
    bytes32 public latestMessageRoot;
    mapping(bytes32 => bool) public authenticatedLeaves;

    error InvalidConfiguration();
    error InvalidProof();
    error StaleUpdate();
    event LeafAccepted(uint32 indexed blockNumber, bytes32 indexed leafHash, bytes32 messageRoot);

    constructor(SP1Beefy consensus_, bytes32 genesis_, bytes memory initial) {
        BeefyConsensusState memory state = abi.decode(initial, (BeefyConsensusState));
        if (
            address(consensus_).code.length == 0 || address(consensus_.verifier()).code.length == 0
                || consensus_.verificationKey() == bytes32(0) || genesis_ == bytes32(0)
                || state.currentAuthoritySet.len == 0 || state.nextAuthoritySet.len == 0
                || state.currentAuthoritySet.root == bytes32(0) || state.nextAuthoritySet.root == bytes32(0)
                || state.nextAuthoritySet.id != state.currentAuthoritySet.id + 1
                || state.latestHeight > type(uint32).max
        ) {
            revert InvalidConfiguration();
        }
        consensus = consensus_;
        genesisHash = genesis_;
        consensusState = initial;
        latestBeefyBlock = uint32(state.latestHeight);
    }

    function submitProof(bytes calldata proof) external {
        (MiniCommitment memory commitment, PartialBeefyMmrLeaf memory leaf, ParachainHeader[] memory headers,,) =
            abi.decode(proof, (MiniCommitment, PartialBeefyMmrLeaf, ParachainHeader[], bytes, bytes32));
        if (commitment.blockNumber <= latestBeefyBlock) revert StaleUpdate();
        if (commitment.blockNumber > type(uint32).max || leaf.version != 32 || headers.length != 0) {
            revert InvalidProof();
        }
        (bytes memory updated,,) = consensus.verify(consensusState, proof);
        BeefyConsensusState memory state = abi.decode(updated, (BeefyConsensusState));
        if (state.latestHeight != commitment.blockNumber) revert InvalidProof();
        bytes32 leafHash = keccak256(Codec.Encode(leaf));
        consensusState = updated;
        latestBeefyBlock = uint32(state.latestHeight);
        latestLeafHash = leafHash;
        latestMessageRoot = leaf.extra;
        authenticatedLeaves[leafHash] = true;
        emit LeafAccepted(latestBeefyBlock, leafHash, leaf.extra);
    }

    /// The Gateway hashes the full 113-byte leaf including the proven message-tree root.
    /// Historical MMR paths are not accepted: Hyperbridge authenticates this exact tip leaf.
    function verifyMMRLeafProof(bytes32 leafHash, bytes32[] calldata path, uint256 order) external view returns (bool) {
        return path.length == 0 && order == 0 && authenticatedLeaves[leafHash];
    }
}
