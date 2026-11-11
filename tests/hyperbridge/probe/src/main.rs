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

use alloy_sol_types::SolValue;
use anyhow::{Context, Result, ensure};
use parity_scale_codec::{Decode, Encode};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sp1_beefy_primitives::{BeefyCommitment, Commitment, PublicInputs};
use sp1_sdk::{ProverClient, SP1Stdin, prelude::*};
use std::{fs, path::PathBuf, time::Instant};

#[derive(Decode)]
struct Signed {
	commitment: Commitment,
	bitmap: Vec<u8>,
	len: u32,
	signatures: Vec<[u8; 65]>,
}
fn bytes(v: &Value) -> Vec<u8> {
	hex::decode(v.as_str().unwrap().strip_prefix("0x").unwrap()).unwrap()
}
fn hx(b: impl AsRef<[u8]>) -> String {
	format!("0x{}", hex::encode(b))
}

#[tokio::main]
async fn main() -> Result<()> {
	let mut args = std::env::args().skip(1);
	let mode = args.next().context("usage: probe execute|prove FIXTURE ELF OUTPUT")?;
	ensure!(mode == "execute" || mode == "prove" || mode == "prove-tip", "unknown mode");
	let fixture: Value = serde_json::from_slice(&fs::read(args.next().context("fixture")?)?)?;
	let elf_bytes = fs::read(args.next().context("upstream ELF")?)?;
	let pins: Value = serde_json::from_str(include_str!("../../upstream.json"))?;
	ensure!(
		hex::encode(Sha256::digest(&elf_bytes))
			== pins["sp1-beefy"]["sha256"]["elf/sp1-beefy-program"],
		"unexpected upstream ELF"
	);
	let out = PathBuf::from(args.next().context("output")?);
	ensure!(!out.exists(), "refusing to overwrite evidence");
	fs::create_dir_all(&out)?;
	let encoded = bytes(&fixture["justification"]);
	ensure!(encoded[0] == 1, "unsupported BEEFY version");
	let mut remaining = &encoded[1..];
	let signed = Signed::decode(&mut remaining)?;
	ensure!(remaining.is_empty(), "trailing justification");
	ensure!(
		signed.len == 1 && signed.bitmap == vec![128] && signed.signatures.len() == 1,
		"captured single-authority fixture required"
	);
	let client = ProverClient::builder().cpu().build().await;
	let elf = Elf::Static(Box::leak(elf_bytes.clone().into_boxed_slice()));
	let pk = client.setup(elf.clone()).await?;
	let started = Instant::now();
	let mut results = Vec::new();
	// Both witnesses use the SAME actual signed commitment and independently verified MMR proofs.
	let kinds = if mode == "prove-tip" { vec!["tip"] } else { vec!["tip", "historical"] };
	for kind in kinds {
		let leaf = &fixture[kind];
		let input: BeefyCommitment = serde_json::from_value(json!({
			"commitment": signed.commitment.encode(),
			"mmr": {"leaf": bytes(&leaf["leaf"]), "index": leaf["leafIndex"].as_str().unwrap().parse::<u64>()?,
				"count": leaf["leafCount"].as_str().unwrap().parse::<u64>()?, "proof": leaf["items"]},
			"authorities": {"len": signed.len, "root": fixture["authority"]["root"],
				"votes": [{"index": 0, "signature": signed.signatures[0].to_vec()}], "proof": []},
			"parachain": {"headers": [], "proof": [], "total_count": 0},
			"nonce": format!("0x{}", "00".repeat(32))
		}))?;
		let mut stdin = SP1Stdin::new();
		stdin.write(&input);
		let (values, report) = client
			.execute(elf.clone(), stdin.clone())
			.await
			.with_context(|| format!("unchanged upstream guest: {kind}"))?;
		let public = PublicInputs::abi_decode(values.as_slice(), true)?;
		ensure!(public.headers.is_empty(), "unexpected parachain headers");
		ensure!(
			public.block_number.to::<u32>() == signed.commitment.block_number,
			"height mismatch"
		);
		let leaf_hash = hx(public.leaf_hash);
		let mut result = json!({"kind": kind, "guestExecuted": true,
            "block": signed.commitment.block_number, "validatorSetId": signed.commitment.validator_set_id,
            "leafHash": leaf_hash, "publicValues": hx(values.as_slice()), "cycles": report.total_instruction_count()});
		if mode != "execute" {
			let proof = client.prove(&pk, stdin).groth16().await?;
			client.verify(&proof, pk.verifying_key(), None)?;
			ensure!(
				proof.public_values.as_slice() == values.as_slice(),
				"proof/execution mismatch"
			);
			proof.save(out.join(format!("{kind}.bin")))?;
			result["proofBytes"] = json!(hx(proof.bytes()));
			result["realGroth16"] = json!(true);
		}
		fs::write(out.join(format!("{kind}.json")), serde_json::to_vec_pretty(&result)?)?;
		results.push(result);
	}
	let result = json!({"upstreamElfSha256": hex::encode(Sha256::digest(&elf_bytes)),
        "programVKey": pk.verifying_key().bytes32(), "sdkVersion": "6.10.0", "mode": mode,
        "seconds": started.elapsed().as_secs_f64(), "results": results,
        "completeBridgeE2E": false});
	fs::write(out.join("probe.json"), serde_json::to_vec_pretty(&result)?)?;
	println!("{}", serde_json::to_string_pretty(&result)?);
	Ok(())
}
