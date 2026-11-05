import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {randomBytes, randomUUID} from "node:crypto";
import {encodeAbiParameters,encodeEventTopics,erc20Abi,keccak256,parseTransaction,type Hex} from "viem";
import {TaskStore} from "../server/tasks/store.ts";
import {PortalStore} from "../server/portal/store.ts";
import {SimChain} from "../server/market/sim-chain.ts";
import {cryptoPayments, type ChainBounty} from "../server/crypto/payments.ts";
import {USDC,CHAIN_ID} from "../server/crypto/evm.ts";
import {hash,type Task,type TaskPolicy} from "../server/tasks/domain.ts";
import {fixtureEvidence} from "../server/tasks/github.ts";
import {evaluateRelease} from "../server/tasks/release-policy.ts";

function world(ctx:TestContext, deadline=false){
 const store=new TaskStore(":memory:"),portal=new PortalStore(store.db,"",randomBytes(32));
 const clock={now:Date.parse("2026-11-05T12:00:00Z"),block:100n};
 const chain=new SimChain(store.db,{rail:"usdc",now:()=>clock.now,operator:"client.testnet",owner:"owner.testnet",verifier:"verifier.testnet",relayer:"relayer.testnet"});
 const env={CRYPTO_CLIENT_ACCOUNT_ID:chain.accounts.operator,CRYPTO_VERIFIER_ACCOUNT_ID:chain.accounts.verifier,CRYPTO_RELAYER_ACCOUNT_ID:chain.accounts.relayer,CRYPTO_ESCROW_CONTRACT_ID:chain.contractId};
 const prior=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]]));Object.assign(process.env,env);
 ctx.after(()=>{store.close();for(const k of Object.keys(env)){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k];}});
 const funding:TaskPolicy={version:1,title:"Example",criteria:["Pass"],amountCents:100,currency:"USD",paymentRail:"base-usdc",refundAddress:"0x"+"c1ea2".repeat(8),repository:"acme/example",repositoryId:1,branch:"main",developerId:0,developerLogin:"Unclaimed",mergerIds:[1],checks:[{name:"acceptance",appId:15368}],workflowPath:".github/workflows/acceptance.yml",protectedFiles:[],baselineSha:"c".repeat(40),mergeMethod:"any",verifier:chain.accounts.verifier,recipient:"Unclaimed",...(deadline?{market:{version:1,kind:"fixed",deliveryHours:1}}:{})};
 const task={id:randomUUID(),mode:"sandbox",githubMode:"fixture",openBounty:true,ownerId:1,policy:structuredClone(funding),policyHash:hash(funding),fundingPolicy:funding,fundingPolicyHash:hash(funding),clientAccepted:true,developerAccepted:false,funded:false,fundedAt:null,disputed:false,prNumber:null,jobId:null,evidence:null,verdict:null,payment:{state:"NotRequested",reference:null,error:null},fixture:"merged",timeline:[],createdAt:new Date(clock.now).toISOString()} as Task;
 store.save(task);
 const logs:any[]=[],receipts=new Map<string,any>(),sent:Hex[]=[],gasCalls:bigint[]=[];
 const blockHash=("0x"+"a1".repeat(32)) as Hex;
 const evm:any={getChainId:async()=>CHAIN_ID,readContract:async()=>6,getBlockNumber:async()=>clock.block,getBlock:async()=>({hash:blockHash}),getLogs:async({fromBlock,toBlock}:any)=>logs.filter(l=>l.blockNumber>=fromBlock&&l.blockNumber<=toBlock),estimateFeesPerGas:async()=>({maxFeePerGas:1_000_000_000n,maxPriorityFeePerGas:1_000_000n}),getTransactionReceipt:async({hash}:any)=>{if(!receipts.has(hash)){const e=new Error("not mined");e.name="TransactionReceiptNotFoundError";throw e;}return receipts.get(hash);},sendRawTransaction:async({serializedTransaction}:any)=>{sent.push(serializedTransaction);return keccak256(serializedTransaction);}};
 const adapter=cryptoPayments(store,portal,{chain,evm,derive:async(path)=>chain.deriveAddress(path),gas:async(_p,_id,_address,units)=>{gasCalls.push(units);},now:()=>clock.now});
 const bounty=()=>chain.view<ChainBounty>("get_bounty",{bounty_id:task.id});
 const transfer=(recipient:string,units:bigint,txHash:Hex,blockNumber=101n)=>({address:USDC,data:encodeAbiParameters([{type:"uint256"}],[units]),topics:encodeEventTopics({abi:erc20Abi,eventName:"Transfer",args:{from:("0x"+"1".repeat(40)) as Hex,to:recipient as Hex}}),logIndex:0,transactionHash:txHash,blockHash,blockNumber});
 const fund=async(units=1_000_000n)=>{await adapter.prepare(task);const h=("0x"+"d1".repeat(32)) as Hex;const l=transfer(task.crypto!.address,units,h);logs.push(l);receipts.set(h,{status:"success",blockHash,blockNumber:101n,logs:[l]});clock.block=113n;await adapter.sync(task);store.save(task);};
 const assign=async()=>{task.policy={...task.policy,developerId:2,developerLogin:"developer",recipient:"0x"+"2".repeat(40),...(deadline?{assignment:{generation:1,marker:"NP-EXAMPLE-A1"}}:{})};task.policyHash=hash(task.policy);task.developerAccepted=true;store.save(task);if(deadline)await adapter.market!(task).bind(task,{generation:1,developerId:2,policyHash:task.policyHash});else await adapter.prepare(task);};
 const evidence=()=>{task.prNumber=7;task.evidence=fixtureEvidence(task);task.verdict=evaluateRelease(task,task.evidence);store.save(task);};
 const mine=async()=>{const b=await bounty(),p=b.payout!;const raw=sent.at(-1)!;const h=keccak256(raw);const l=transfer(p.recipient,BigInt(p.amount_units),h);receipts.set(h,{status:"success",from:task.crypto!.address,to:USDC,blockHash,blockNumber:101n,logs:[l]});};
 return{store,portal,clock,chain,task,adapter,bounty,fund,assign,evidence,mine,sent,gasCalls};
}

for(const deadline of [false,true])test(`real USDC adapter uses the new ABI and settles once (${deadline?'deadline':'open'})`,async ctx=>{
 const w=world(ctx,deadline);await w.fund();assert.equal(w.task.funded,true);await w.assign();w.evidence();
 if(deadline){w.task.marketSubmission={generation:1,prNumber:7,headSha:w.task.evidence!.headSha,receivedAt:w.clock.now,relayedAt:null};await assert.rejects(()=>w.adapter.release(w.task),/not been recorded/);await w.adapter.market!(w.task).recordSubmission(w.task,{generation:1,policyHash:w.task.policyHash,headSha:w.task.evidence!.headSha,observedAtMs:w.clock.now});w.task.marketSubmission.relayedAt=w.clock.now;}
 await w.adapter.release(w.task);assert.equal(w.task.payment.state,'Signing');await w.adapter.release(w.task);assert.equal(w.sent.length,1);await w.adapter.release(w.task);assert.equal(new Set(w.sent).size,1,'retries reuse identical signed bytes');await w.mine();await w.adapter.release(w.task);assert.equal(w.task.payment.state,'Processed');assert.equal(w.chain.calls.filter(c=>c.method==='settle_bounty').length,1);assert.equal((await w.bounty()).payout!.tx_hash,keccak256(w.sent[0]!));
});

test('owner resume cannot waive CI, merge or the recorded submission',async ctx=>{
 const w=world(ctx);await w.fund();await w.assign();w.evidence();await w.adapter.dispute(w.task,'client');
 await w.chain.call(w.chain.accounts.owner,'resolve_dispute',{bounty_id:w.task.id,outcome:'Resume',max_fee:'0',priority_fee:'0'});
 assert.equal((await w.bounty()).payout,null);await w.adapter.sync(w.task);assert.equal(w.task.disputed,false);
 for(const mutate of [(e:any)=>e.checks=[],(e:any)=>e.merged=false,(e:any)=>e.checks[0].conclusion='failure']){w.evidence();mutate(w.task.evidence);Object.assign(w.task,{ownerAcceptance:{ownerId:1}});await assert.rejects(()=>w.adapter.release(w.task),/qualifying merge/);}
 assert.equal(w.gasCalls.length,0);assert.equal((await w.bounty()).payout,null);
});

test('owner refund returns recorded units including surplus, without marking a developer paid',async ctx=>{
 const w=world(ctx);await w.fund(1_500_000n);await w.adapter.dispute(w.task,'client');await w.chain.call(w.chain.accounts.owner,'resolve_dispute',{bounty_id:w.task.id,outcome:'Refund',max_fee:'1000000000',priority_fee:'1000000'});
 await w.adapter.sync(w.task);assert.equal(w.sent.length,1);await w.mine();await w.adapter.sync(w.task);assert.equal(w.task.refund?.state,'Processed');assert.equal(w.task.payment.state,'NotRequested');assert.equal((await w.bounty()).payout!.amount_units,'1500000');assert.equal((await w.bounty()).payout!.recipient,w.task.policy.refundAddress);
});

test('changed funding terms and a different signed journal fail closed before broadcast',async ctx=>{
 const w=world(ctx);await w.fund();const expected=w.task.policy.refundAddress;w.task.policy.refundAddress='0x'+'3'.repeat(40);await assert.rejects(()=>w.adapter.prepare(w.task),/funded agreement/);w.task.policy.refundAddress=expected;await w.assign();w.evidence();await w.adapter.release(w.task);w.portal.meta('crypto-payout:'+w.task.id,w.portal.seal({raw:'0x01',hash:'0x02'}));await assert.rejects(()=>w.adapter.release(w.task),/journal/);assert.equal(w.sent.length,0);
});


test('funding instructions disappear during disputes and after a partial-deposit refund',async ctx=>{
 const w=world(ctx);await w.fund(500_000n);
 assert.equal((await w.adapter.deposit(w.task) as any).address,w.task.crypto!.address);
 assert.equal(w.task.funded,false);assert(w.task.crypto!.verifiedFundingHash);
 await w.adapter.dispute(w.task,'client');
 assert.equal((await w.adapter.deposit(w.task) as any).address,null);
 await w.chain.call(w.chain.accounts.owner,'resolve_dispute',{bounty_id:w.task.id,outcome:'Resume',max_fee:'0',priority_fee:'0'});
 assert.equal((await w.adapter.deposit(w.task) as any).address,w.task.crypto!.address);
 await w.adapter.dispute(w.task,'client');
 await w.chain.call(w.chain.accounts.owner,'resolve_dispute',{bounty_id:w.task.id,outcome:'Refund',max_fee:'1000000000',priority_fee:'1000000'});
 assert.equal((await w.adapter.deposit(w.task) as any).address,null);
 await w.adapter.sync(w.task);await w.mine();await w.adapter.sync(w.task);
 assert.equal(w.task.refund?.state,'Processed');assert.equal(w.task.payment.state,'NotRequested');
 assert.equal((await w.bounty()).payout!.amount_units,'500000');
});
