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

import {Test} from "forge-std/Test.sol";
import {SP1Beefy} from "hyperbridge/consensus/SP1Beefy.sol";
import {
    BeefyConsensusState,
    AuthoritySetCommitment,
    MiniCommitment,
    PartialBeefyMmrLeaf,
    ParachainHeader
} from "hyperbridge/consensus/Types.sol";
import {Codec} from "hyperbridge/consensus/Codec.sol";
import {IntermediateState} from "@hyperbridge/core/interfaces/IConsensusV2.sol";
import {SP1Verifier} from "@sp1-contracts/v6.1.0/SP1VerifierGroth16.sol";
import {MidnightHyperbridgeClient} from "midnight-adapter/MidnightHyperbridgeClient.sol";

/// Compatibility checks use real SP1 proofs of a consensus-generated Midnight commitment.
contract CompatibilityTest is Test {
    SP1Beefy client;
    string fixture;
    string tip;
    string historical;
    bytes previous;
    uint256 blockNumber;

    function setUp() public {
        fixture = vm.readFile("../fixtures/midnight-live.json");
        string memory directory = vm.envOr("HYPERBRIDGE_PROOF_DIR", string("../fixtures/compatibility"));
        string memory program = vm.readFile(string.concat(directory, "/probe.json"));
        tip = vm.readFile(string.concat(directory, "/tip.json"));
        historical = vm.readFile(string.concat(directory, "/historical.json"));
        require(vm.parseJsonBool(tip, ".realGroth16") && vm.parseJsonBool(historical, ".realGroth16"));
        client = new SP1Beefy(new SP1Verifier(), vm.parseJsonBytes32(program, ".programVKey"));
        blockNumber = vm.parseJsonUint(tip, ".block");
        uint64 id = uint64(vm.parseJsonUint(fixture, ".authority.id"));
        bytes32 root = vm.parseJsonBytes32(fixture, ".authority.root");
        previous = abi.encode(
            BeefyConsensusState({
                latestHeight: 0,
                beefyActivationBlock: 1,
                currentAuthoritySet: AuthoritySetCommitment(id - 1, 1, root),
                nextAuthoritySet: AuthoritySetCommitment(id, 1, root)
            })
        );
    }

    function leaf(string memory kind) internal view returns (PartialBeefyMmrLeaf memory result) {
        bytes memory raw = vm.parseJsonBytes(fixture, string.concat(".", kind, ".leaf"));
        require(raw.length == 113);
        result.version = uint8(raw[0]);
        result.parentNumber = uint32(little(raw, 1, 4));
        result.parentHash = word(raw, 5);
        result.nextAuthoritySet =
            AuthoritySetCommitment(uint64(little(raw, 37, 8)), uint32(little(raw, 45, 4)), word(raw, 49));
        result.extra = word(raw, 81);
        assertEq(
            keccak256(Codec.Encode(result)), vm.parseJsonBytes32(kindEqualsTip(kind) ? tip : historical, ".leafHash")
        );
    }

    function kindEqualsTip(string memory kind) internal pure returns (bool) {
        return keccak256(bytes(kind)) == keccak256("tip");
    }

    function proof(PartialBeefyMmrLeaf memory mmrLeaf, string memory evidence) internal view returns (bytes memory) {
        return abi.encode(
            MiniCommitment(blockNumber, vm.parseJsonUint(evidence, ".validatorSetId")),
            mmrLeaf,
            new ParachainHeader[](0),
            vm.parseJsonBytes(evidence, ".proofBytes"),
            bytes32(0)
        );
    }

    function testRealTipProofAcceptedButHasNoApplicationState() public view {
        (bytes memory updated, IntermediateState[] memory states,) = client.verify(previous, proof(leaf("tip"), tip));
        assertEq(abi.decode(updated, (BeefyConsensusState)).latestHeight, blockNumber);
        assertEq(states.length, 0);
        assertEq(leaf("tip").extra, bytes32(0));
        assertNotEq(leaf("historical").extra, bytes32(0));
    }

    function testRealHistoricalProofRejectedAsStaleLeaf() public {
        vm.expectRevert(SP1Beefy.StaleMmrLeaf.selector);
        client.verify(previous, proof(leaf("historical"), historical));
    }

    function testCannotRewriteHistoricalLeafToBypassCheck() public {
        PartialBeefyMmrLeaf memory forged = leaf("historical");
        forged.parentNumber = uint32(blockNumber - 1);
        vm.expectRevert();
        client.verify(previous, proof(forged, historical));
    }

    function testWrongAuthorityRootRejectedByRealVerifier() public {
        BeefyConsensusState memory state = abi.decode(previous, (BeefyConsensusState));
        state.nextAuthoritySet.root = bytes32(uint256(1));
        vm.expectRevert();
        client.verify(abi.encode(state), proof(leaf("tip"), tip));
    }

    function testWrongProgramKeyRejectedByRealVerifier() public {
        SP1Beefy wrong = new SP1Beefy(new SP1Verifier(), bytes32(uint256(1)));
        bytes memory encoded = proof(leaf("tip"), tip);
        vm.expectRevert();
        wrong.verify(previous, encoded);
    }

    function testTamperedProofRejectedByRealVerifier() public {
        bytes memory encoded = proof(leaf("tip"), tip);
        encoded[encoded.length - 33] ^= 0x01;
        vm.expectRevert();
        client.verify(previous, encoded);
    }

    function testStaleHeightIsNoOp() public view {
        bytes memory encoded = proof(leaf("tip"), tip);
        (bytes memory state,,) = client.verify(previous, encoded);
        (bytes memory replay, IntermediateState[] memory states,) = client.verify(state, encoded);
        assertEq(state, replay);
        assertEq(states.length, 0);
    }

    function testAdapterPersistsOnlyTheProvenTipAndRejectsReplay() public {
        MidnightHyperbridgeClient receiver = new MidnightHyperbridgeClient(client, bytes32(uint256(1)), previous);
        bytes memory encoded = proof(leaf("tip"), tip);
        receiver.submitProof(encoded);
        assertEq(receiver.latestBeefyBlock(), blockNumber);
        bytes32 hash = keccak256(Codec.Encode(leaf("tip")));
        assertTrue(receiver.authenticatedLeaves(hash));
        assertTrue(receiver.verifyMMRLeafProof(hash, new bytes32[](0), 0));
        assertFalse(receiver.verifyMMRLeafProof(keccak256(Codec.Encode(leaf("historical"))), new bytes32[](0), 0));
        assertFalse(receiver.verifyMMRLeafProof(hash, new bytes32[](1), 0));
        vm.expectRevert(MidnightHyperbridgeClient.StaleUpdate.selector);
        receiver.submitProof(encoded);
    }

    function little(bytes memory raw, uint256 offset, uint256 length) internal pure returns (uint256 value) {
        for (uint256 i; i < length; ++i) {
            value |= uint256(uint8(raw[offset + i])) << (8 * i);
        }
    }

    function word(bytes memory raw, uint256 offset) internal pure returns (bytes32 value) {
        assembly { value := mload(add(add(raw, 32), offset)) }
    }
}
