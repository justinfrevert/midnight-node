#!/usr/bin/env python3
# This file is part of midnight-node.
# Copyright (C) Midnight Foundation
# SPDX-License-Identifier: Apache-2.0
# Licensed under the Apache License, Version 2.0 (the "License");
# You may not use this file except in compliance with the License.
# You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Validate and hash evidence from completed live PoS/native-ingress stages."""
import hashlib
import json
from pathlib import Path
import sys
import subprocess
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
ART=ROOT / "artifacts/snowbridge"
run=Path(sys.argv[1]).resolve()
assert run.is_relative_to(ART / "ethereum-pos")
read=lambda name:json.loads((run / name).read_text())
live=read("midnight-beacon-evidence.json")
assert "failure" not in live
assert live["bootstrapFinalized"] and live["liveBeaconUpdateVerified"]
assert live["nativeTokenIssuedLive"] and live["duplicateIssuanceRejected"] and live["duplicateReceiptRejected"]
assert live["ledgerBefore"]["contractCount"] == 0
assert live["ledgerAfter"]["contractCount"] == 1
assert live["ledgerAfter"]["unshieldedUtxoCount"] == live["ledgerBefore"]["unshieldedUtxoCount"] + 1
assert live["ledgerAfter"]["unshieldedUtxoStars"] == live["ledgerBefore"]["unshieldedUtxoStars"]
assert live["ledgerAfter"]["dustNullifierCount"] > live["ledgerBefore"]["dustNullifierCount"]
for name in ["receipt-test.log","ledger-build.log","issuance-replay.log"]:
    log=(run / name).read_text()
    assert "test result: ok. 1 passed" in log and "test result: FAILED" not in log, name
proof=read("receipt/evidence.json")
status=read("status.json")
assert int(status["finalizedExecution"]["number"],16) >= proof["executionBlock"]
network=read("network.json")
deployment=read("deployment.json")
def rpc(method,params):
    request=urllib.request.Request(network["execution"],json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(),{"content-type":"application/json"})
    with urllib.request.urlopen(request,timeout=10) as response:
        result=json.load(response)
    assert "error" not in result,result
    return result["result"]
block=rpc("eth_getBlockByNumber",[hex(proof["executionBlock"]),False])
assert block["hash"] == proof["block"]
word=deployment["custody"].removeprefix("0x").lower().rjust(64,"0")
custody=int(rpc("eth_call",[{"to":deployment["token"],"data":"0x70a08231"+word},status["finalizedExecution"]["number"]]),16)
outbound=live.get("outboundRedemptionLive",False)
assert custody == (60 if outbound else 100)
smoke=read("midnight-node-smoke.json")
assert smoke["genesisHash"] == live["genesisHash"] and smoke["finalizedNumber"] >= 3
files=["bootstrap/checkpoint.scale","receipt/update.scale","receipt/event.scale","receipt/evidence.json",
    "receipt-test.log","midnight-beacon-evidence.json","midnight-node-smoke.json","network.json","compose.json","status.json","broadcast.json",
    "ledger/registry.json","ledger/genesis-state.bin","ledger/escrow-proven.bin","ledger/live-issuance.bin","issuance-replay.log"]
compact=live.get("liveCompactConsumerRoundTrip",False)
if compact:
    assert live["reissuanceAfterSpendingRejected"]
    assert [step["consumerBalance"] for step in live["compactSteps"]] == ["0","100","100","60","60"]
    assert "test result: ok. 1 passed" in (run / "compact-prove.log").read_text()
    assert live["compact"]["consumerBalance"] == 60 and live["compact"]["escrowBalance"] == 40
    assert live["compact"]["walletBalance"] == 0
    if outbound:
        post=read("post-redemption-state.json")
        assert post["complete"] and post["redemptionPhase"] == "Completed"
        assert post["midnightGenesis"] == smoke["genesisHash"]
        assert post["midnightFinalizedNumber"] <= smoke["finalizedNumber"]
        assert post["compact"] == {"consumer":60,"escrow":40}
        assert post["ethereum"]["custody"] == 60 and post["ethereum"]["recipient"] == 40
        assert int(status["finalizedExecution"]["number"],16) >= post["ethereum"]["finalizedNumber"]
        for name,expected in post["sha256"].items():
            assert hashlib.sha256((run/name).read_bytes()).hexdigest() == expected
        files += ["post-redemption-state.json", "ledger/final-consumer-state.bin", "ledger/final-escrow-state.bin"]
    assert live["compact"]["consumerBalance"] + live["compact"]["walletBalance"] + (0 if outbound else live["compact"]["escrowBalance"]) == custody
    assert live["compact"]["ledgerStats"]["contractCount"] == 2
    assert live["compact"]["ledgerStats"]["unshieldedUtxoCount"] == live["ledgerBefore"]["unshieldedUtxoCount"]
    files += ["compact-prove.log","ledger/compact-manifest.json","ledger/live-consumer-state.bin","ledger/live-escrow-state.bin"]
    files += [f"ledger/compact-proven-{index}.bin" for index in range(5)]
if live.get("verifierRepair"):
    assert live["verifierRepair"]["persistedFinalizedHistoryRechecked"]
    files += ["midnight-beacon-evidence-before-verifier-fix.json", "midnight-readback.log", "execution-finalized-readback.json"]
if outbound:
    assert compact and live["completeBridgeE2E"]
    result=live["outbound"]
    assert post["redemptionId"] == result["id"]
    compact_manifest=read("ledger/compact-manifest.json")
    assert post["compactContracts"] == {name:compact_manifest[name] for name in ("consumer","escrow","color")}
    assert post["ethereum"]["finalizedNumber"] >= read("release-receipt-1/evidence.json")["executionBlock"]
    assert result["phase"] == "Completed" and result["liveConsensusProofs"]
    assert [attempt["success"] for attempt in result["attempts"]] == [False,True]
    assert result["attempts"][0]["nonce"] != result["attempts"][1]["nonce"]
    assert all(attempt["finalizedReceiptVerified"] for attempt in result["attempts"])
    recipient=int(rpc("eth_call",[{"to":deployment["token"],"data":"0x70a08231"+("05"*20).rjust(64,"0")},status["finalizedExecution"]["number"]]),16)
    assert recipient == 40 and custody + recipient == 100
    checkpoint=read("beefy-checkpoint.json")
    assert checkpoint["midnightGenesis"] == smoke["genesisHash"]
    assert checkpoint["midnightGenesisLedgerRoot"] == smoke["genesisLedgerRoot"]
    assert checkpoint["ethereumGenesis"] == rpc("eth_getBlockByNumber",["0x0",False])["hash"]
    files += ["beefy-checkpoint.json","deployment.json","genesis-build.log"]
    for index in range(2):
        release=read(f"release-receipt-{index}/evidence.json")
        assert int(status["finalizedExecution"]["number"],16) >= release["executionBlock"]
        assert rpc("eth_getBlockByNumber",[hex(release["executionBlock"]),False])["hash"] == release["block"]
        attempt=result["attempts"][index]
        assert release["transaction"] == attempt["ethereumTransaction"]
        receipt=rpc("eth_getTransactionReceipt",[attempt["ethereumTransaction"]])
        assert int(receipt["status"],16) == 1 and receipt["blockHash"] == release["block"]
        # keccak256(InboundMessageDispatched(uint64,bytes32,bool,bytes32)).
        dispatch_topic="0x8856ab63954e6c2938803a4654fb704c8779757e7bfdbe94a578e341ec637a95"
        log,=[entry for entry in receipt["logs"] if entry["address"].lower() == deployment["gateway"].lower() and entry["topics"][0] == dispatch_topic]
        assert len(log["topics"]) == 2 and int(log["topics"][1],16) == attempt["nonce"]
        data=bytes.fromhex(log["data"].removeprefix("0x"))
        assert len(data) == 96 and "0x"+data[:32].hex() == result["id"]
        assert int.from_bytes(data[32:64],"big") == index
        assert int(log["logIndex"],16) == release["logIndex"]
        files += [f"release-receipt-{index}/{name}" for name in ["event.scale","update.scale","evidence.json"]]
        files += [f"outbound-proof-{index}.json",f"mmr-{index}.json",f"mmr-input-{index}.json",f"release-broadcast-{index}.json"]
    if not deployment.get("hyperbridge",False):
        files += [f"mmr-simple-{index}/simplified.json" for index in range(2)]
    files += [p.name for p in run.glob("beefy-*.scale")]
hyperbridge=deployment.get("hyperbridge",False)
if hyperbridge:
    subprocess.run(["python3", str(ROOT / "tests/hyperbridge/prepare.py"), "--check-only"], check=True)
    assert outbound
    key=read("hyperbridge-key.json")
    assert key["programVKey"] == "0x007d1720c695842ed647a1a72e981751f9b5e26fc5ca038523b23430a1292f08"
    assert checkpoint["midnightGenesis"] == smoke["genesisHash"]
    final_block=status["finalizedExecution"]["number"]
    def code_hash(address):
        return rpc("web3_sha3",[rpc("eth_getCode",[address,final_block])])
    def receiver_call(signature, argument=""):
        selector=rpc("web3_sha3",["0x"+signature.encode().hex()])[:10]
        return rpc("eth_call",[{"to":deployment["beefyClient"],"data":selector+argument},final_block])
    expected_code={"verifierCodeHash":code_hash(deployment["sp1Verifier"]),
        "consensusCodeHash":code_hash(deployment["hyperbridgeConsensus"]),
        "receiverCodeHash":code_hash(deployment["beefyClient"])}
    leaf_topic=rpc("web3_sha3",["0x"+b"LeafAccepted(uint32,bytes32,bytes32)".hex()])
    assert receiver_call("genesisHash()") == checkpoint["midnightGenesis"]
    for attempt in result["attempts"]:
        accepted=attempt["hyperbridge"]
        release=read(f"outbound-proof-{attempt['index']}.json")
        assert release["leaf"]["parentNumber"]+1 == accepted["block"]
        assert release["leafProof"] == [] and int(release["leafProofOrder"]) == 0
        assert release["leaf"]["parachainHeadsRoot"] == accepted["messageRoot"]
        for update in accepted["updates"]:
            assert update["realGroth16"] and update["finalized"]
            job=read(f"hyperbridge/job-{update['block']}.json")
            assert job["phase"] == "Finalized" and job["negativeChecks"] == 4
            assert job["programVKey"] == key["programVKey"]
            assert job["elfSha256"] == key["upstreamElfSha256"]
            assert all(job[field] == expected for field,expected in expected_code.items())
            assert rpc("web3_sha3",[job["rawTransaction"]]) == update["transaction"]
            receipt=rpc("eth_getTransactionReceipt",[update["transaction"]])
            assert int(receipt["status"],16) == 1 and receipt["to"].lower() == deployment["beefyClient"].lower()
            assert rpc("eth_getBlockByNumber",[receipt["blockNumber"],False])["hash"] == receipt["blockHash"]
            assert receipt["blockHash"] == job["receipt"]["blockHash"]
            assert int(status["finalizedExecution"]["number"],16) >= int(receipt["blockNumber"],16)
            assert int(receipt["gasUsed"],16) == int(update["gasUsed"])
            accepted_log,=[entry for entry in receipt["logs"] if entry["address"].lower() == deployment["beefyClient"].lower() and entry["topics"][0] == leaf_topic]
            assert len(accepted_log["topics"]) == 3
            assert int(accepted_log["topics"][1],16) == update["block"]
            assert accepted_log["topics"][2] == update["leafHash"]
            assert accepted_log["data"] == update["messageRoot"]
            assert int(receiver_call("authenticatedLeaves(bytes32)",update["leafHash"][2:]),16) == 1
    last=result["attempts"][-1]["hyperbridge"]
    assert int(receiver_call("latestBeefyBlock()"),16) == last["block"]
    assert receiver_call("latestLeafHash()") == last["leafHash"]
    assert receiver_call("latestMessageRoot()") == last["messageRoot"]
    files += ["hyperbridge-key.json", "hyperbridge-observed.json", "hyperbridge-upstream.json"]
    files += [p.name for p in sorted(run.glob("committee-*.json"))]
    if (run/"hyperbridge-backfill.json").exists(): files += ["hyperbridge-backfill.json"]
    files += [str(p.relative_to(run)) for p in sorted((run/"hyperbridge").rglob("*")) if p.is_file()]
manual_files = sorted(run.glob("manual/*.request.json")) + sorted(run.glob("manual/*.response.json"))
files += [str(path.relative_to(run)) for path in manual_files]
evidence={"profile":"live-pos-bidirectional-compact" if outbound else ("live-pos-compact-ingress" if compact else "live-pos-native-ingress"),"completeBridgeE2E":outbound,
    "operatorPaced":bool(manual_files), "hyperbridgeFinalityProved":hyperbridge, "hyperbridgeUpstreamUnmodified":hyperbridge, "committeeStateVerified":hyperbridge,
    "nativeTokenIssuedLive":True,"outboundRedemptionLive":outbound,"liveCompactConsumerRoundTrip":compact,
    "ethereumCustody":custody,"nativeAmountIssued":100,"realPoSReceiptVerifiedByPallet":True,"liveMidnightBeaconUpdate":True,
    "escrowAndLedgerDoublesInPalletTest":True,"liveNodeUsesRealEscrowAndLedger":True,
    "outboundCheckpointSyntheticAndUnused":not outbound,"deploymentChainBindingHashesAreFixtures":not outbound,
    "ledgerFees":"default, funded with real DUST proofs",
    "localStackRecovery":network.get("recovery"),
    "compactResult":live.get("compact"),
    "postRedemptionState":post if compact and outbound else None,
    "outboundResult":live.get("outbound"),
    "verifierRepair":live.get("verifierRepair"),
    "binarySha256":smoke["binarySha256"],"metadataSha256":smoke["metadataSha256"],
    "sha256":{name:hashlib.sha256((run/name).read_bytes()).hexdigest() for name in files}}
(run / "validation.json").write_text(json.dumps(evidence,indent=2)+"\n")
print("PASS: live PoS receipt, Midnight beacon update, native issuance" + (", Compact round trip" if compact else "") + (", failed release, retry and completed Ethereum redemption" if outbound else "") + f". Evidence: {run}/validation.json")
