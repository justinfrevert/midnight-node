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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, concat, AbiCoder } from 'ethers';
import { messageTree, decodeLeaf, STATE_TYPE, recoverCommitteeProofs, recoverJustifications } from './hyperbridge-relay.mjs';

test('message proofs preserve every older redemption through all 64 history entries',()=>{
  const leaves=Array.from({length:64},(_,i)=>keccak256(new Uint8Array([i])));
  for(let count=1;count<=64;count++)for(let index=0;index<count;index++) {
    const {root,path}=messageTree(leaves.slice(0,count),index);
    let value=leaves[index];
    for(const sibling of path)value=keccak256(concat([value,sibling].sort()));
    assert.equal(value,root);
    if(path.length) {
      value=leaves[index];
      for(const sibling of [keccak256(new Uint8Array([255])),...path.slice(1)])value=keccak256(concat([value,sibling].sort()));
      assert.notEqual(value,root);
    }
  }
  assert.throws(()=>messageTree([],0));assert.throws(()=>messageTree(leaves,-1));
  assert.throws(()=>messageTree([...leaves,leaves[0]],0));
});

test('captured standalone leaves and Hyperbridge state retain byte-exact fields',()=>{
  const fixture=JSON.parse(readFileSync(new URL('../hyperbridge/fixtures/midnight-live.json',import.meta.url)));
  const leaf=decodeLeaf(fixture.tip.leaf);
  assert.equal(leaf.parentNumber+1,252);assert.equal(leaf.extra,'0x'+'00'.repeat(32));
  assert.notEqual(decodeLeaf(fixture.historical.leaf).extra,leaf.extra);
  assert.throws(()=>decodeLeaf(fixture.tip.leaf.slice(0,-2)));
  const coder=AbiCoder.defaultAbiCoder();
  const set={id:0,len:1,root:fixture.authority.root};
  const decoded=coder.decode([STATE_TYPE],coder.encode([STATE_TYPE],[{latestHeight:3,beefyActivationBlock:1,current:set,next:{...set,id:1}}]))[0];
  assert.equal(decoded.next.id,1n);assert.equal(decoded.current.root,set.root);
});
test('committee recovery pins RPC requests to signed blocks and rejects stale or non-tip leaves',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hyperbridge-committee-'));
  try {
    writeFileSync(join(dir,'beefy-checkpoint.json'),JSON.stringify({height:3}));
    writeFileSync(join(dir,'beefy-5.scale'),Buffer.from([1]));
    writeFileSync(join(dir,'beefy-8.scale'),Buffer.from([1]));
    const leaf=Buffer.alloc(113); leaf[0]=0x20; leaf.writeUInt32LE(4,1);
    const proof={leafIndices:[4n],leafCount:5n,items:[]};
    const api={rpc:{chain:{getBlockHash:async n=>({toHex:()=>`hash-${n}`})}},
      registry:{createType:type=>type==='Vec<Bytes>'?[{toU8a:()=>leaf}]:proof}};
    const provider={send:async(method,args)=>{
      assert.equal(method,'mmr_generateProof'); assert.deepEqual(args,[[5],5,'hash-5']); return {};
    }};
    leaf.writeUInt32LE(3,1);
    await assert.rejects(recoverCommitteeProofs(api,provider,dir,5),/historical/);
    assert(!existsSync(join(dir,'committee-5.json')));
    leaf.writeUInt32LE(4,1); proof.leafIndices=[3n];
    await assert.rejects(recoverCommitteeProofs(api,provider,dir,5),/not the MMR tip/);
    proof.leafIndices=[4n];
    await recoverCommitteeProofs(api,provider,dir,5);
    const saved=JSON.parse(readFileSync(join(dir,'committee-5.json')));
    assert.equal(saved.blockHash,'hash-5'); assert.equal(saved.leafCount,'5');
    assert(!existsSync(join(dir,'committee-8.json')));
    provider.send=async()=>{throw Error('must reuse saved witness');};
    await recoverCommitteeProofs(api,provider,dir,5);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
test('reconnect backfill persists finalized BEEFY witnesses and does not advance on RPC failure',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'hyperbridge-backfill-'));
  try {
    writeFileSync(join(dir,'beefy-checkpoint.json'),JSON.stringify({height:3}));
    const api={rpc:{chain:{getFinalizedHead:async()=> 'final',getHeader:async()=>({number:{toNumber:()=>5}}),getBlockHash:async n=>({toHex:()=>String(n)})}}};
    const provider={send:async(_, [n])=>{if(n==='5')throw Error('disconnect');return {justifications:[['0x42454546','0x010203'],['0x46524e4b','0x99']]};}};
    await assert.rejects(recoverJustifications(api,provider,dir,9),/disconnect/);
    assert(!existsSync(join(dir,'hyperbridge-backfill.json')));
    provider.send=async()=>({justifications:[[[66,69,69,70],[1,2,3]]]});
    await recoverJustifications(api,provider,dir,9);
    assert.equal(JSON.parse(readFileSync(join(dir,'hyperbridge-backfill.json'))).block,5);
    assert.equal(readFileSync(join(dir,'beefy-4.scale')).toString('hex'),'010203');
    assert.equal(readFileSync(join(dir,'beefy-5.scale')).toString('hex'),'010203');
    assert(!existsSync(join(dir,'beefy-6.scale')));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
