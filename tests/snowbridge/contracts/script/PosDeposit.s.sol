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
import {BridgeTest, TestToken} from "../test/Bridge.t.sol";
import {BeefyClient} from "snowbridge/BeefyClient.sol";
import {GatewayProxy} from "snowbridge/GatewayProxy.sol";
import {AgentExecutor} from "snowbridge/AgentExecutor.sol";
import {Constants} from "snowbridge/Constants.sol";
import {Initializer} from "snowbridge/Initializer.sol";
import {OperatingMode} from "snowbridge/Types.sol";
import {MidnightGateway} from "../src/MidnightGateway.sol";

import {MidnightHyperbridgeClient} from "../src/MidnightHyperbridgeClient.sol";
import {SP1Beefy} from "hyperbridge/consensus/SP1Beefy.sol";
import {BeefyConsensusState, AuthoritySetCommitment} from "hyperbridge/consensus/Types.sol";
import {SP1Verifier} from "sp1-contracts/v6.1.0/SP1VerifierGroth16.sol";

/// Deploy against the actual disposable Midnight chain and its observed BEEFY sets.
contract PosDeposit is BridgeTest {
    function setUp() public override {}

    function run() external {
        vm.startBroadcast();
        string memory checkpoint = vm.readFile(vm.envString("SNOWBRIDGE_BEEFY_CHECKPOINT"));
        address verifier;
        address lightClient;
        bool useHyperbridge = vm.envOr("SNOWBRIDGE_HYPERBRIDGE", false);
        require(!vm.envOr("SNOWBRIDGE_SP1", false), "Legacy SP1 path removed; use Hyperbridge");
        address hyperbridgeConsensus;
        if (useHyperbridge) {
            string memory key = vm.readFile(vm.envString("HYPERBRIDGE_KEY"));
            verifier = address(new SP1Verifier());
            SP1Beefy consensus = new SP1Beefy(SP1Verifier(verifier), vm.parseJsonBytes32(key, ".programVKey"));
            hyperbridgeConsensus = address(consensus);
            bytes memory initial = abi.encode(
                BeefyConsensusState({
                    latestHeight: vm.parseJsonUint(checkpoint, ".height"),
                    beefyActivationBlock: 1,
                    currentAuthoritySet: AuthoritySetCommitment(
                        uint64(vm.parseJsonUint(checkpoint, ".current.id")),
                        uint32(vm.parseJsonUint(checkpoint, ".current.len")),
                        vm.parseJsonBytes32(checkpoint, ".current.root")
                    ),
                    nextAuthoritySet: AuthoritySetCommitment(
                        uint64(vm.parseJsonUint(checkpoint, ".next.id")),
                        uint32(vm.parseJsonUint(checkpoint, ".next.len")),
                        vm.parseJsonBytes32(checkpoint, ".next.root")
                    )
                })
            );
            lightClient = address(
                new MidnightHyperbridgeClient(consensus, vm.parseJsonBytes32(checkpoint, ".midnightGenesis"), initial)
            );
        } else {
            client = new BeefyClient(
                0,
                0,
                1,
                1,
                0,
                BeefyClient.ValidatorSet(
                    uint128(vm.parseJsonUint(checkpoint, ".current.id")),
                    uint128(vm.parseJsonUint(checkpoint, ".current.len")),
                    vm.parseJsonBytes32(checkpoint, ".current.root")
                ),
                BeefyClient.ValidatorSet(
                    uint128(vm.parseJsonUint(checkpoint, ".next.id")),
                    uint128(vm.parseJsonUint(checkpoint, ".next.len")),
                    vm.parseJsonBytes32(checkpoint, ".next.root")
                )
            );
            lightClient = address(client);
        }
        token = new TestToken();
        MidnightGateway implementation = new MidnightGateway(lightClient, address(new AgentExecutor()));
        Initializer.Config memory config;
        config.mode = OperatingMode.Normal;
        gateway = MidnightGateway(
            address(
                new GatewayProxy(
                    address(implementation),
                    abi.encode(
                        MidnightGateway.Config(
                            config,
                            vm.parseJsonBytes32(checkpoint, ".ethereumGenesis"),
                            vm.parseJsonBytes32(checkpoint, ".midnightGenesis"),
                            bytes32("local-round-trip"),
                            address(token)
                        )
                    )
                )
            )
        );
        custody = gateway.agentOf(Constants.ASSET_HUB_AGENT_ID);
        gateway.v2_registerToken(address(token), 0, 0, 0);
        token.approve(address(gateway), type(uint256).max);
        // Public BIP340 development key [1; 32], used by the live Compact wallet.
        bytes32 owner = 0xec3925bdbd24aa1cfd002f9ccf52f2bc30061721d8841e86c93c087c1fd2bdcb;
        bytes[] memory assets = new bytes[](1);
        assets[0] = abi.encode(uint8(0), address(token), uint128(100));
        gateway.v2_sendMessage(abi.encode(uint8(1), gateway.bridgeDomain(), owner), assets, "", 0, 0);
        vm.stopBroadcast();
        assertEq(token.balanceOf(custody), 100);
        string memory key = "pos-deposit";
        vm.serializeAddress(key, "beefyClient", lightClient);
        vm.serializeBool(key, "hyperbridge", useHyperbridge);
        vm.serializeAddress(key, "hyperbridgeConsensus", hyperbridgeConsensus);
        vm.serializeAddress(key, "sp1Verifier", verifier);
        vm.serializeBytes32(key, "midnightOwner", owner);
        vm.serializeAddress(key, "gateway", address(gateway));
        vm.serializeAddress(key, "token", address(token));
        vm.serializeBytes32(key, "bridgeDomain", gateway.bridgeDomain());
        string memory json = vm.serializeAddress(key, "custody", custody);
        vm.writeJson(json, vm.envString("SNOWBRIDGE_POS_DEPLOYMENT"));
    }
}
