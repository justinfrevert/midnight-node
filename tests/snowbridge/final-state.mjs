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

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ApiPromise, WsProvider } from '@polkadot/api';
import { Contract, JsonRpcProvider } from 'ethers';
import * as rt from '@midnight-ntwrk/compact-runtime';
import * as escrowContract from '../../artifacts/snowbridge/compact/escrow/contract/index.js';

export async function captureFinalState(api, provider, dir) {
  const read=name=>JSON.parse(readFileSync(join(dir,name)));
  const deployment=read('deployment.json'), network=read('network.json');
  const manifest=read('ledger/compact-manifest.json');
  const id=read('outbound-proof-0.json').message.topic;
  const hash=(await api.rpc.chain.getFinalizedHead()).toHex();
  const at=await api.at(hash);
  const redemption=(await at.query.ethereumBridge.redemptions(id)).unwrap();
  assert(redemption.phase.isCompleted,'redemption must be finalized before final contract readback');
  const result={complete:true,midnightGenesis:api.genesisHash.toHex(),midnightFinalizedHash:hash,
    midnightFinalizedNumber:(await api.rpc.chain.getHeader(hash)).number.toNumber(),redemptionId:id,
    redemptionPhase:'Completed',redemption:redemption.toJSON(),compactContracts:{consumer:manifest.consumer,escrow:manifest.escrow,color:manifest.color},compact:{},sha256:{}};
  for(const [name,amount] of [['consumer',60n],['escrow',40n]]) {
    const encoded=await provider.send('midnight_contractState',[manifest[name],hash]);
    const bytes=Buffer.from(encoded.replace(/^0x/,''),'hex');
    const state=rt.ContractState.deserialize(bytes);
    assert.deepEqual([...state.balance],[[{tag:'unshielded',raw:manifest.color},amount]]);
    const expected=rt.ContractState.deserialize(readFileSync(join(dir,`ledger/expected-${name}-state.bin`)));
    assert.deepEqual(state.data.state.encode(),expected.data.state.encode());
    if(name==='escrow') {
      const record=escrowContract.ledger(state.data);
      assert.equal(record.nextSequence,1n);assert.equal(record.totalRetired,40n);assert.equal(record.records.size(),1n);
      assert.deepEqual(record.records.lookup(0n),{amount:40n,recipient:new Uint8Array(20).fill(5)});
      assert.deepEqual(state.operations(),['retire']);assert.deepEqual(state.maintenanceAuthority.committee,[]);
      assert.equal(state.maintenanceAuthority.threshold,1);
    }
    const filename=`ledger/final-${name}-state.bin`;writeFileSync(join(dir,filename),bytes);
    result.compact[name]=Number(amount);result.sha256[filename]=createHash('sha256').update(bytes).digest('hex');
  }
  const ethereum=new JsonRpcProvider(network.execution);
  try {
    const finalized=await ethereum.send('eth_getBlockByNumber',['finalized',false]);
    const token=new Contract(deployment.token,['function balanceOf(address) view returns(uint256)'],ethereum);
    const options={blockTag:Number(BigInt(finalized.number))};
    const custody=await token.balanceOf(deployment.custody,options);
    const recipient=await token.balanceOf('0x'+'05'.repeat(20),options);
    assert.equal(custody,60n);assert.equal(recipient,40n);
    result.ethereum={finalizedHash:finalized.hash,finalizedNumber:Number(BigInt(finalized.number)),
      custody:Number(custody),recipient:Number(recipient)};
  } finally {ethereum.destroy();}
  writeFileSync(join(dir,'post-redemption-state.json'),JSON.stringify(result,null,2)+'\n');
  console.log('PASS: final Compact consumer 60 / sealed escrow 40; Ethereum custody 60 / recipient 40; redemption Completed');
  return result;
}

// Observe an already-running test without submitting transactions.
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const dir=resolve(process.argv[2]);
  const provider=new WsProvider(`ws://127.0.0.1:${process.env.SNOWBRIDGE_NODE_PORT??19944}`);
  const api=await ApiPromise.create({provider});
  try {
    const deadline=Date.now()+7_200_000;
    for(;;) {
      assert(Date.now()<deadline,'timed out waiting for completed redemption');
      const path=join(dir,'outbound-proof-0.json');
      if(existsSync(path)) {
        const id=JSON.parse(readFileSync(path)).message.topic;
        const at=await api.at(await api.rpc.chain.getFinalizedHead());
        const record=await at.query.ethereumBridge.redemptions(id);
        if(record.isSome&&record.unwrap().phase.isCompleted) {
          await captureFinalState(api,provider,dir);break;
        }
      }
      await new Promise(resolve=>setTimeout(resolve,2000));
    }
  } finally {await api.disconnect();}
}
