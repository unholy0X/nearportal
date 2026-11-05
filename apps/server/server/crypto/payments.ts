import {encodeFunctionData,erc20Abi,parseTransaction,keccak256,type Hex,type Address} from 'viem';
import {env} from '../env.ts';
import {view as chainView,call as chainCall,deriveEscrowAddress as chainAddress,invalidateViews} from '../chain.ts';
import {hash,note,type Task} from '../tasks/domain.ts';
import type {TaskStore} from '../tasks/store.ts';
import type {PortalStore} from '../portal/store.ts';
import type {PaymentAdapter} from '../tasks/payments.ts';
import {publicClient,USDC,CHAIN_ID,centsToUnits,incomingTransfers,signedPayout,address,depositScanEnd} from './evm.ts';
import {ensureCryptoGas} from './gas.ts';
import {cryptoMarketRail, deliverySeconds, type RawAssignment, type Chain} from '../market/rail.ts';
import {evaluateRelease} from '../tasks/release-policy.ts';
export interface ChainBounty {
 client:string; verifier:string; funding_policy_hash:string; reward_cents:string;
 delivery_seconds:number|null; refund_address:string; escrow_evm_address:Address;
 state:'VerifyingAddress'|'AwaitingDeposit'|'Funded'|'Disputed'|'Closed'|'Cancelled';
 deposited_units:string; generation:number; assignment:RawAssignment|null;
 payout:null|{kind:'Developer'|'Refund';recipient:string;amount_units:string;unsigned_tx:Hex;digest:string;evidence_hash:string|null;signature:Hex|null;signing:boolean;attempt:number;requested_at_secs:string;tx_hash:Hex|null};
}
interface Runtime {
 chain:Chain; evm:ReturnType<typeof publicClient>; derive:(path:string)=>Promise<string>;
 gas:typeof ensureCryptoGas; now:()=>number;
}
export function cryptoPayments(store:TaskStore,portal:PortalStore, runtime:Partial<Runtime>={}):PaymentAdapter {
 const c=runtime.evm??publicClient(),verifier=process.env.CRYPTO_VERIFIER_ACCOUNT_ID!,client=process.env.CRYPTO_CLIENT_ACCOUNT_ID!,relayer=process.env.CRYPTO_RELAYER_ACCOUNT_ID!,contract=process.env.CRYPTO_ESCROW_CONTRACT_ID!;
 const now=runtime.now??Date.now, gas=runtime.gas??ensureCryptoGas;
 const view=<T>(method:string,args:Record<string,unknown>={})=>runtime.chain ? runtime.chain.view<T>(method,args) : chainView<T>(method,args,contract);
 const call=(signer:string,method:string,args:Record<string,unknown>,deposit:`${number}`="0")=>runtime.chain ? runtime.chain.call(signer,method,args,deposit) : chainCall(signer,method,args,deposit,contract);
 const deriveEscrowAddress=(path:string)=>runtime.derive ? runtime.derive(path) : chainAddress(path,contract);
 const get=(t:Task)=>view<ChainBounty|null>('get_bounty',{bounty_id:t.id});
 // All assignments use the same contract interface, with or without a delivery deadline.
 const marketRail=cryptoMarketRail({view,call:(signer,method,args,deposit)=>call(signer,method,args,deposit??"0")},{verifier});
 const configured=()=>{if(env.network!=='testnet'||env.monerium.chain!=='basesepolia'||!verifier||!client||!relayer||!contract?.endsWith('.testnet')||contract===env.contractId)throw new Error('USDC rail requires the configured NEAR testnet verifier and Base Sepolia');};
 // Network and token identity are immutable for a given RPC endpoint: verify once per 10 minutes
 // (failures are never cached). Deposits and payouts are still confirmed live on every pass.
 let verifiedUntil=0;
 const safe=async()=>{configured();if(now()<verifiedUntil)return;if(await c.getChainId()!==CHAIN_ID)throw new Error('Wrong crypto RPC network');if(await c.readContract({address:USDC,abi:erc20Abi,functionName:'decimals'})!==6)throw new Error('Unexpected USDC token deployment');verifiedUntil=now()+600_000;};
 async function match(t:Task){
  const b=await get(t);
  if(!b||b.client!==client||b.verifier!==verifier||b.funding_policy_hash!==t.fundingPolicyHash||b.reward_cents!==String(t.policy.amountCents)||b.delivery_seconds!==deliverySeconds(t)||b.refund_address!==address(t.policy.refundAddress)||b.escrow_evm_address!==t.crypto?.address)
   throw new Error('Crypto escrow does not match the funded agreement');
  if(b.state==='Cancelled')throw new Error('Escrow address verification failed; do not fund this bounty');
  return b;
 }
 async function confirmReceipt(raw:Hex,txHash:Hex,t:Task,recipient:string,units:bigint) {
  const tx=parseTransaction(raw),r=await c.getTransactionReceipt({hash:txHash});
  if(r.status!=='success')throw new Error('USDC payout reverted; manual reconciliation required');
  if(r.from.toLowerCase()!==t.crypto!.address||r.to?.toLowerCase()!==USDC||keccak256(raw)!==txHash||tx.data!==encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[address(recipient),units]}))throw new Error('Payout receipt does not match the authorized transfer');
  if(await c.getBlockNumber()-r.blockNumber<12n)return false;
  if((await c.getBlock({blockNumber:r.blockNumber})).hash!==r.blockHash)return false;
  const receipt=incomingTransfers(r.logs,recipient);
  if(receipt.length!==1||receipt[0]!.units!==units)throw new Error('Payout receipt lacks the exact USDC transfer');
  return true;
 }
 return {
  market:()=>marketRail,
  async prepare(t){
   await safe();if(t.policy.paymentRail!=='base-usdc'||t.policy.currency!=='USD')throw new Error('Not a USDC task');
   let b=await get(t);
   if(!t.crypto){const start=(await c.getBlockNumber()).toString();const path=await view<string>('get_escrow_path',{bounty_id:t.id});t.crypto={startBlock:start,scanBlock:start,address:(await deriveEscrowAddress(path)).toLowerCase(),depositedUnits:'0',surplusUnits:'0'};store.save(t);}
   if(!b){await call(client,'create_bounty',{bounty_id:t.id,bounty:{funding_policy_hash:t.fundingPolicyHash,reward_cents:String(t.policy.amountCents),delivery_seconds:deliverySeconds(t),refund_address:address(t.policy.refundAddress),escrow_evm_address:t.crypto.address}},'0.1');b=await get(t);}
   b=await match(t);
   if(b.state==='VerifyingAddress'){const key='crypto-address-retry:'+t.id;if(now()-Number(portal.meta(key)||0)>60000){portal.meta(key,String(now()));await call(client,'retry_address_check',{bounty_id:t.id});}return;}
   if(t.crypto.verifiedFundingHash!==t.fundingPolicyHash){t.crypto.verifiedFundingHash=t.fundingPolicyHash;store.save(t);}
   // Deadline assignments are bound by the common lifecycle after an exclusive claim.
   if(t.policy.market||!t.policy.developerId||b.state!=='Funded') return;
   if(!b.assignment)await call(verifier,'assign_developer',{bounty_id:t.id,generation:b.generation+1,assignment_hash:t.policyHash,developer_id:String(t.policy.developerId),recipient_address:t.policy.recipient});
   else if(b.assignment.assignment_hash!==t.policyHash||b.assignment.recipient!==t.policy.recipient||b.assignment.developer_id!==String(t.policy.developerId))throw new Error('Crypto recipient binding mismatch');
  },
  async sync(t){
   await safe();if(!t.crypto)return;let b=await match(t);if(b.state==='VerifyingAddress')return;
   const latest=await c.getBlockNumber(),safeBlock=latest>12n?latest-12n:0n;
   const from=BigInt(t.crypto.scanBlock),to=depositScanEnd(from,safeBlock);
   const readLogs=(first:bigint,last:bigint)=>c.getLogs({address:USDC,event:{type:'event' as const,name:'Transfer',inputs:[{name:'from',type:'address',indexed:true},{name:'to',type:'address',indexed:true},{name:'value',type:'uint256',indexed:false}]},args:{to:address(t.crypto!.address)},fromBlock:first,toBlock:last});
   const recordLogs=async(logs:Awaited<ReturnType<typeof readLogs>>)=>{
    for(const log of logs){
     if(!log.transactionHash||log.blockNumber===null||log.logIndex===null)throw new Error('Incomplete deposit log');
     const r=await c.getTransactionReceipt({hash:log.transactionHash}),block=await c.getBlock({blockNumber:r.blockNumber});
     if(r.status!=='success'||block.hash!==r.blockHash||r.blockHash!==log.blockHash||r.blockNumber>safeBlock)throw new Error('Unconfirmed or noncanonical deposit');
     for(const entry of incomingTransfers([log],t.crypto!.address)){
      // Contract deduplication makes recovery safe after a crash between chain recording and local save.
      const known=t.crypto!.deposits?.some(d=>d.txHash===log.transactionHash&&d.logIndex===log.logIndex);
      if(!known){await call(relayer,'record_deposit',{bounty_id:t.id,units:entry.units.toString(),reference:entry.reference});
       (t.crypto!.deposits??=[]).push({txHash:log.transactionHash,logIndex:log.logIndex,blockNumber:String(r.blockNumber),units:String(entry.units)});store.save(t);}
     }
    }
   };
   if(from<=to){await recordLogs(await readLogs(from,to));t.crypto.scanBlock=(to+1n).toString();store.save(t);}
   invalidateViews();b=await match(t);const amount=BigInt(b.deposited_units);t.crypto.depositedUnits=String(amount);t.crypto.surplusUnits=String(amount>centsToUnits(t.policy.amountCents)?amount-centsToUnits(t.policy.amountCents):0n);
   if(amount>=centsToUnits(t.policy.amountCents))t.funded=true;
   // Recover receipts for bounties funded before receipt metadata was stored.
   // Work backwards in bounded requests; never infer a transaction from a balance alone.
   for(let page=0;page<5;page++){
    const knownUnits=(t.crypto.deposits??[]).reduce((sum,d)=>sum+BigInt(d.units),0n);
    if(knownUnits>=amount)break;
    const end=BigInt(t.crypto.receiptBackfillTo??String(from-1n)),first=BigInt(t.crypto.startBlock);
    if(end<first)break;
    const capped=end<safeBlock?end:safeBlock,begin=capped-199n>first?capped-199n:first;
    if(begin>capped)break;
    await recordLogs(await readLogs(begin,capped));t.crypto.receiptBackfillTo=String(begin-1n);store.save(t);
   }
   t.disputed=b.state==='Disputed'||b.payout?.kind==='Refund';
   if(b.payout && (b.payout.kind==='Refund'?t.refund?.state!=='Processed':t.payment.state!=='Processed')) await this.release(t);
  },
  async release(t){
   await safe();let b=await match(t);
   const refund=b.payout?.kind==='Refund';
   if(refund){
    // The owner authorizes refunds on chain. The worker cannot choose a destination or amount.
    if(b.state!=='Closed'||b.payout!.recipient!==b.refund_address||b.payout!.evidence_hash!==null||BigInt(b.payout!.amount_units)<=0n||BigInt(b.payout!.amount_units)>BigInt(b.deposited_units))throw new Error('Invalid authorized refund');
   }else{
    if(!t.evidence||t.verdict?.status!=='eligible'||!t.prNumber||t.policyHash!==hash(t.policy)||evaluateRelease(t,t.evidence).status!=='eligible')throw new Error('Verified qualifying merge required for USDC release');
    if(!t.funded||!t.clientAccepted||!t.developerAccepted||t.disputed||!b.assignment||b.assignment.assignment_hash!==t.policyHash||b.assignment.recipient!==t.policy.recipient||b.assignment.developer_id!==String(t.policy.developerId)||b.state==='Disputed')throw new Error('Crypto release agreement mismatch');
    if(!b.payout){
     const head=t.policy.market?t.marketSubmission?.headSha:t.evidence.headSha;
     if(!head||head!==t.evidence.headSha)throw new Error('Only the exact submitted commit can be paid');
     if(!t.policy.market&&b.assignment.head_sha!==head){
      await call(verifier,'record_submission',{bounty_id:t.id,generation:b.assignment.generation,assignment_hash:t.policyHash,head_sha:head,observed_at_ns:(BigInt(now())*1_000_000n).toString()});
      b=await match(t);
     }
     if(b.assignment?.head_sha!==head)throw new Error('Submission has not been recorded on the escrow');
     const fees=await c.estimateFeesPerGas();const max=fees.maxFeePerGas!,priority=fees.maxPriorityFeePerGas!;
     if(!max||priority===undefined||max>100_000_000_000n||priority>max)throw new Error('Unsafe payout gas fee quote');
     await gas(portal,t.id,address(t.crypto!.address),120000n*max+1_000_000_000_000n);
     await call(verifier,'settle_bounty',{bounty_id:t.id,generation:b.assignment.generation,assignment_hash:t.policyHash,head_sha:head,evidence_hash:t.verdict.evidenceHash,max_fee:max.toString(),priority_fee:priority.toString()});
     t.payment.state='Signing';t.payment.error=null;return;
    }
    if(b.payout.kind!=='Developer'||b.payout.recipient!==t.policy.recipient||BigInt(b.payout.amount_units)!==centsToUnits(t.policy.amountCents)||b.payout.evidence_hash!==t.verdict.evidenceHash)throw new Error('Authorized crypto evidence changed; manual reconciliation required');
   }
   const payout=b.payout!,payment=refund?(t.refund??={state:'Signing',reference:null,error:null}):t.payment;
   if(!payout.signature){payment.state='Signing';if(BigInt(Math.floor(now()/1000))>BigInt(payout.requested_at_secs)+900n)await call(verifier,'retry_payout_signature',{bounty_id:t.id});return;}
   const units=BigInt(payout.amount_units),recipient=payout.recipient;
   const verified=await signedPayout(payout.unsigned_tx,payout.signature,{escrow:t.crypto!.address,recipient,units});
   const intentKey='crypto-payout:'+t.id;
   let intent=portal.meta(intentKey)?portal.open<{raw:Hex;hash:Hex}>(portal.meta(intentKey)!):null;
   if(!intent){intent=verified;portal.meta(intentKey,portal.seal(intent));}
   if(intent.raw!==verified.raw||intent.hash!==verified.hash)throw new Error('Payout journal does not match the authorized transaction');
   payment.state='Submitted';payment.reference=`https://sepolia.basescan.org/tx/${intent.hash}`;store.save(t);
   try{
    if(await confirmReceipt(intent.raw,intent.hash,t,recipient,units)){
     if(!payout.tx_hash)await call(relayer,'mark_payout_processed',{bounty_id:t.id,tx_hash:intent.hash});
     else if(payout.tx_hash!==intent.hash)throw new Error('Processed payout hash mismatch');
     payment.state='Processed';payment.error=null;note(t,refund?'USDC dispute refund confirmed on Base Sepolia.':'USDC payout confirmed on Base Sepolia.');
    }
   }catch(error){
    if((error as Error).name==='TransactionReceiptNotFoundError'){
     const tx=parseTransaction(payout.unsigned_tx);
     await gas(portal,t.id,address(t.crypto!.address),120000n*tx.maxFeePerGas!+1_000_000_000_000n);
     try{await c.sendRawTransaction({serializedTransaction:intent.raw});}catch{/* Unknown broadcast outcome: retry same signed bytes only. */}
     return;
    }
    throw error;
   }
  },
  async dispute(t){await call(client,'open_dispute',{bounty_id:t.id});},
  async deposit(t){
   configured();if(t.policy.paymentRail!=='base-usdc'||t.policy.currency!=='USD')throw new Error('Not a USDC task');
   // An address can remain valid while funding has closed or a dispute is open. Always
   // read current state before offering instructions; cached immutable terms are insufficient.
   await safe();const b=await match(t);
   const depositAddress=b.state==='AwaitingDeposit'||b.state==='Funded'?b.escrow_evm_address:null;
   return {iban:null,reference:t.id,rail:'base-usdc',chainId:CHAIN_ID,token:USDC,address:depositAddress,amountUnits:centsToUnits(t.policy.amountCents).toString(),confirmations:12};
  }
 };
}
