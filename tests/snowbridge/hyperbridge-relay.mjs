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
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AbiCoder, Contract, JsonRpcProvider, Wallet, keccak256, concat } from 'ethers';
const ROOT = resolve(import.meta.dirname, '../..');
const coder = AbiCoder.defaultAbiCoder();
export const STATE_TYPE = 'tuple(uint256 latestHeight,uint256 beefyActivationBlock,tuple(uint64 id,uint32 len,bytes32 root) current,tuple(uint64 id,uint32 len,bytes32 root) next)';
const SET_TYPE = 'tuple(uint64 id,uint32 len,bytes32 root)';
const LEAF_TYPE = `tuple(uint8 version,uint32 parentNumber,bytes32 parentHash,${SET_TYPE} nextAuthoritySet,bytes32 extra)`;
const ABI = ['function consensusState() view returns(bytes)', 'function consensus() view returns(address)',
  'function latestBeefyBlock() view returns(uint32)', 'function latestLeafHash() view returns(bytes32)',
  'function latestMessageRoot() view returns(bytes32)', 'function authenticatedLeaves(bytes32) view returns(bool)',
  'function submitProof(bytes proof)'];
const hex = b => '0x'+Buffer.from(b).toString('hex');

function rpcBytes(value) {
  if (typeof value === 'string') {
    assert(/^0x(?:[0-9a-fA-F]{2})*$/.test(value),'invalid RPC hex bytes');
    return Buffer.from(value.slice(2),'hex');
  }
  assert(Array.isArray(value) && value.every(n=>Number.isInteger(n)&&n>=0&&n<=255),'invalid RPC byte array');
  return Buffer.from(value);
}
function atomic(path, value) {
  writeFileSync(path+'.tmp', JSON.stringify(value, null, 2)+'\n'); renameSync(path+'.tmp',path);
}
// Backfill consensus proofs from finalized source blocks after a listener gap/restart.
// These are witnesses; the guest still authenticates every transition from destination state.
export async function recoverJustifications(api, provider, dir, target) {
  const cursorPath=join(dir,'hyperbridge-backfill.json');
  const initial=JSON.parse(readFileSync(join(dir,'beefy-checkpoint.json'))).height;
  let cursor=existsSync(cursorPath)?JSON.parse(readFileSync(cursorPath)).block:initial;
  const finalHeader=await api.rpc.chain.getHeader(await api.rpc.chain.getFinalizedHead());
  const end=Math.min(target,finalHeader.number.toNumber());
  while(cursor<end) {
    const numbers=Array.from({length:Math.min(32,end-cursor)},(_,i)=>cursor+i+1);
    await Promise.all(numbers.map(async number=>{
      const path=join(dir,`beefy-${number}.scale`);
      if(existsSync(path)) return;
      const hash=(await api.rpc.chain.getBlockHash(number)).toHex();
      const signed=await provider.send('chain_getBlock',[hash]);
      assert(signed && typeof signed === 'object','historical source block unavailable');
      for(const [engine,proof] of signed.justifications??[]) {
        if(rpcBytes(engine).equals(Buffer.from('BEEF'))) {
          writeFileSync(path+'.tmp',rpcBytes(proof)); renameSync(path+'.tmp',path);
        }
      }
    }));
    cursor=numbers.at(-1); atomic(cursorPath,{block:cursor});
  }
}

// Fetch the tip leaf at each captured commitment, never a latest-state authority list.
// RPC data is only a witness: the SP1 guest checks inclusion against the signed root.
export async function recoverCommitteeProofs(api, provider, dir, target) {
  const initial=JSON.parse(readFileSync(join(dir,'beefy-checkpoint.json'))).height;
  const blocks=readdirSync(dir).map(name=>/^beefy-(\d+)\.scale$/.exec(name))
    .filter(Boolean).map(match=>Number(match[1])).filter(block=>block>initial&&block<=target).sort((a,b)=>a-b);
  for(const block of blocks) {
    const path=join(dir,`committee-${block}.json`);
    if(existsSync(path)) continue;
    const hash=(await api.rpc.chain.getBlockHash(block)).toHex();
    const result=await provider.send('mmr_generateProof',[[block],block,hash]);
    const leaves=api.registry.createType('Vec<Bytes>',result.leaves);
    const proof=api.registry.createType('MmrBatchProof',result.proof);
    assert.equal(leaves.length,1,'one committee tip leaf required');
    assert.equal(proof.leafIndices.length,1,'one committee tip index required');
    const leaf=Buffer.from(leaves[0].toU8a(true));
    assert.equal(leaf.length,113); assert.equal(leaf[0],0x20);
    assert.equal(leaf.readUInt32LE(1)+1,block,'historical committee leaf');
    assert.equal(BigInt(proof.leafIndices[0].toString())+1n,BigInt(proof.leafCount.toString()),'not the MMR tip');
    atomic(path,{block,blockHash:hash,leaf:hex(leaf),leafIndex:proof.leafIndices[0].toString(),
      leafCount:proof.leafCount.toString(),items:proof.items.map(item=>item.toHex())});
  }
}

export function decodeLeaf(leafHex) {
  const b=Buffer.from(leafHex.slice(2),'hex');
  assert.equal(b.length,113); assert.equal(b[0],32);
  return {version:b[0],parentNumber:b.readUInt32LE(1),parentHash:hex(b.subarray(5,37)),
    nextAuthoritySet:{id:b.readBigUInt64LE(37).toString(),len:b.readUInt32LE(45),root:hex(b.subarray(49,81))},extra:hex(b.subarray(81))};
}
export function messageTree(leaves, index) {
  assert(Number.isInteger(index)&&index>=0&&index<leaves.length&&leaves.length<=64);
  let level=[...leaves], position=index; const path=[];
  while(level.length>1) {
    const sibling=position^1; if(sibling<level.length) path.push(level[sibling]);
    const next=[];
    for(let i=0;i<level.length;i+=2) {
      if(i+1===level.length)next.push(level[i]);
      else next.push(keccak256(concat([level[i],level[i+1]].sort())));
    }
    position=Math.floor(position/2); level=next;
  }
  return {root:level[0],path};
}

export async function proveAndRelay(api, sourceProvider, dir, target) {
  const network=JSON.parse(readFileSync(join(dir,'network.json')));
  const deployment=JSON.parse(readFileSync(join(dir,'deployment.json')));
  assert.equal(deployment.hyperbridge,true);
  const provider=new JsonRpcProvider(network.execution);
  const signer=new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',provider);
  const client=new Contract(deployment.beefyClient,ABI,signer);
  const consensus=new Contract(await client.consensus(),['function verificationKey() view returns(bytes32)','function verifier() view returns(address)'],provider);
  const work=join(dir,'hyperbridge'); mkdirSync(work,{recursive:true});
  const accepted=[];
  try {
    await recoverJustifications(api,sourceProvider,dir,target);
    await recoverCommitteeProofs(api,sourceProvider,dir,target);
    for(;;) {
      const state=coder.decode([STATE_TYPE],await client.consensusState())[0];
      assert(Number(state.latestHeight)<target,'destination already passed requested target');
      const decode=block=>api.registry.createType('BeefyVersionedFinalityProof',readFileSync(join(dir,`beefy-${block}.scale`))).asV1;
      const targetSigned=decode(target);
      let block=target, signed=targetSigned;
      if(targetSigned.commitment.validatorSetId.toBigInt()>state.next.id) {
        const candidates=readdirSync(dir).map(n=>/^beefy-(\d+)\.scale$/.exec(n)).filter(Boolean)
          .map(m=>Number(m[1])).filter(n=>n>Number(state.latestHeight)&&n<target).sort((a,b)=>a-b);
        block=candidates.find(n=>{
          const c=decode(n).commitment;
          const id=c.validatorSetId.toBigInt();
          return (id===state.current.id||id===state.next.id)&&BigInt(decodeLeaf(JSON.parse(readFileSync(join(dir,`committee-${n}.json`))).leaf).nextAuthoritySet.id)>state.next.id;
        });
        assert(block,'missing authenticated authority transition'); signed=decode(block);
      }
      const id=signed.commitment.validatorSetId.toBigInt();
      const authority=id===state.current.id?state.current:state.next;
      assert.equal(id,authority.id,'unknown authority set'); assert.equal(Number(authority.len),1,'single-authority dev profile');
      const witness=JSON.parse(readFileSync(join(dir,`committee-${block}.json`)));
      const leaf=decodeLeaf(witness.leaf);
      assert.equal(leaf.parentNumber+1,block);
      const fixture={justification:hex(readFileSync(join(dir,`beefy-${block}.scale`))),
        authority:{id:authority.id.toString(),len:Number(authority.len),root:authority.root},tip:witness};
      const jobPath=join(work,`job-${block}.json`);
      let job=existsSync(jobPath)?JSON.parse(readFileSync(jobPath)):null;
      const out=job?.out??join(work,`proof-${block}-${Date.now()}`);
      if(!job?.proof) {
        const input=join(work,`input-${block}.json`); atomic(input,fixture);
        atomic(jobPath,{phase:'Proving',block,out});
        const result=await promisify(execFile)(join(ROOT,'artifacts/snowbridge/sp1-target/release/midnight-hyperbridge-probe'),
          ['prove-tip',input,join(ROOT,'artifacts/hyperbridge/sp1-beefy/elf/sp1-beefy-program'),out],
          {cwd:ROOT,env:process.env,timeout:7_200_000,maxBuffer:32*1024*1024});
        writeFileSync(join(work,`prove-${block}.log`),result.stdout+result.stderr);
        const meta=JSON.parse(readFileSync(join(out,'probe.json')));
        assert.equal(meta.programVKey,await consensus.verificationKey());
        job={phase:'Proved',block,out,proof:JSON.parse(readFileSync(join(out,'tip.json'))),programVKey:meta.programVKey,
          elfSha256:meta.upstreamElfSha256};
        atomic(jobPath,job);
      }
      const proof=job.proof; assert.equal(proof.realGroth16,true);
      const encoded=coder.encode(['tuple(uint256 blockNumber,uint256 validatorSetId)',LEAF_TYPE,'tuple(uint256 id,bytes header)[]','bytes','bytes32'],
        [[block,id],leaf,[],proof.proofBytes,'0x'+'00'.repeat(32)]);
      if(!job.transaction) {
        const flip=value=>{const b=Buffer.from(value.slice(2),'hex');b[b.length-1]^=1;return hex(b);};
        const verifier=new Contract(await consensus.verifier(),['function verifyProof(bytes32,bytes,bytes) view'],provider);
        await assert.rejects(verifier.verifyProof(job.programVKey,proof.publicValues,flip(proof.proofBytes)));
        await assert.rejects(verifier.verifyProof(flip(job.programVKey),proof.publicValues,proof.proofBytes));
        await assert.rejects(verifier.verifyProof(job.programVKey,flip(proof.publicValues),proof.proofBytes));
        await client.submitProof.staticCall(encoded);
        const request=await client.submitProof.populateTransaction(encoded);
        job.rawTransaction=await signer.signTransaction(await signer.populateTransaction({...request,gasLimit:1_000_000}));
        job.transaction=keccak256(job.rawTransaction); job.phase='Submitted'; atomic(jobPath,job);
      }
      if(!(await provider.getTransaction(job.transaction))) await provider.broadcastTransaction(job.rawTransaction);
      const receipt=await provider.waitForTransaction(job.transaction,1,900_000);
      assert(receipt&&receipt.status===1,'Hyperbridge transaction failed');
      const deadline=Date.now()+900_000;
      while(Date.now()<deadline) {
        const finalized=await provider.send('eth_getBlockByNumber',['finalized',false]);
        if(finalized&&BigInt(finalized.number)>=BigInt(receipt.blockNumber))break;
        await new Promise(r=>setTimeout(r,4000));
      }
      const final=await provider.send('eth_getBlockByNumber',['finalized',false]);
      assert(final&&BigInt(final.number)>=BigInt(receipt.blockNumber),'Hyperbridge proof not finalized');
      assert.equal((await provider.getBlock(receipt.blockNumber)).hash,receipt.blockHash);
      assert(await client.authenticatedLeaves(proof.leafHash));
      assert.equal(await client.latestMessageRoot(),leaf.extra);
      assert.equal(Number(await client.latestBeefyBlock()),block);
      await assert.rejects(client.submitProof.staticCall(encoded));
      job.phase='Finalized';job.receipt=receipt.toJSON();job.negativeChecks=4;
      job.leafHash=proof.leafHash;job.messageRoot=leaf.extra;
      job.verifierCodeHash=keccak256(await provider.getCode(await consensus.verifier()));
      job.consensusCodeHash=keccak256(await provider.getCode(await client.consensus()));
      job.receiverCodeHash=keccak256(await provider.getCode(deployment.beefyClient)); atomic(jobPath,job);
      accepted.push({block,transaction:job.transaction,gasUsed:receipt.gasUsed.toString(),leafHash:proof.leafHash,
        messageRoot:leaf.extra,realGroth16:true,finalized:true});
      if(block===target) return {updates:accepted,...accepted.at(-1)};
    }
  } finally { provider.destroy(); }
}
