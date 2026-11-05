import {encodeFunctionData,erc20Abi,parseTransaction,keccak256,type Hex,type Address} from 'viem';
import {env} from '../env.ts';
import {view as chainView,call as chainCall,deriveEscrowAddress as chainAddress,invalidateViews} from '../chain.ts';
import {hash,note,type Task} from '../tasks/domain.ts';
import type {TaskStore} from '../tasks/store.ts';
import type {PortalStore} from '../portal/store.ts';
import type {PaymentAdapter} from '../tasks/payments.ts';
import {publicClient,USDC,CHAIN_ID,centsToUnits,incomingTransfers,signedPayout,address,depositScanEnd} from './evm.ts';
import {ensureCryptoGas} from './gas.ts';
import {cryptoMarketRail} from '../market/rail.ts';
import {escrowVerifier} from './verifier.ts';
interface ChainJob {client:string;verifier:string;funding_hash:string;policy_hash:string|null;cents:number;escrow_address:Address;address_verified:boolean;recipient:string|null;deposited_units:string;disputed:boolean;payout:null|{unsigned_tx:Hex;digest:string;evidence_hash:string;signature:Hex|null;signing:boolean;attempt:number;signed_at_secs:number;tx_hash:Hex|null};}
export function cryptoPayments(store:TaskStore,portal:PortalStore):PaymentAdapter {
 const legacyVerifier=process.env.CRYPTO_LEGACY_VERIFIER_ACCOUNT_ID;
 const c=publicClient(),verifier=process.env.CRYPTO_VERIFIER_ACCOUNT_ID!,client=process.env.CRYPTO_CLIENT_ACCOUNT_ID!,relayer=process.env.CRYPTO_RELAYER_ACCOUNT_ID!,contract=process.env.CRYPTO_ESCROW_CONTRACT_ID!;
 const view=<T>(method:string,args:Record<string,unknown>={})=>chainView<T>(method,args,contract);
 const call=(signer:string,method:string,args:Record<string,unknown>,deposit:`${number}`="0")=>chainCall(signer,method,args,deposit,contract);
 const deriveEscrowAddress=(path:string)=>chainAddress(path,contract);
 const get=(t:Task)=>view<ChainJob|null>('get_crypto_bounty',{id:t.id});
 // Fixed-deadline assignments on the USDC escrow (crypto.rs market extension, separate storage).
 const marketRail=cryptoMarketRail({view,call:(signer,method,args,deposit)=>call(signer,method,args,deposit??"0")},{client,verifier});
 const configured=()=>{if(env.network!=='testnet'||env.monerium.chain!=='basesepolia'||!verifier||!client||!relayer||!contract?.endsWith('.testnet')||contract===env.contractId)throw new Error('USDC rail requires the configured NEAR testnet verifier and Base Sepolia');};
 // Network and token identity are immutable for a given RPC endpoint: verify once per 10 minutes
 // (failures are never cached). Deposits and payouts are still confirmed live on every pass.
 let verifiedUntil=0;
 const safe=async()=>{configured();if(Date.now()<verifiedUntil)return;if(await c.getChainId()!==CHAIN_ID)throw new Error('Wrong crypto RPC network');if(await c.readContract({address:USDC,abi:erc20Abi,functionName:'decimals'})!==6)throw new Error('Unexpected USDC token deployment');verifiedUntil=Date.now()+600_000;};
 async function match(t:Task){const b=await get(t);if(!b||b.client!==client||b.funding_hash!==t.fundingPolicyHash||b.cents!==t.policy.amountCents||b.escrow_address!==t.crypto?.address)throw new Error('Crypto escrow does not match the funded agreement');escrowVerifier(b.verifier,verifier,legacyVerifier,Boolean(t.policy.market));return b;}
 async function confirmReceipt(raw:Hex,txHash:Hex,t:Task) {
  const tx=parseTransaction(raw),r=await c.getTransactionReceipt({hash:txHash});
  if(r.status!=='success')throw new Error('USDC payout reverted; manual reconciliation required');
  if(r.from.toLowerCase()!==t.crypto!.address||r.to?.toLowerCase()!==USDC||keccak256(raw)!==txHash||tx.data!==encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[address(t.policy.recipient),centsToUnits(t.policy.amountCents)]}))throw new Error('Payout receipt does not match the authorized transfer');
  if(await c.getBlockNumber()-r.blockNumber<12n)return false;
  if((await c.getBlock({blockNumber:r.blockNumber})).hash!==r.blockHash)return false;
  const receipt=incomingTransfers(r.logs,t.policy.recipient);
  if(receipt.length!==1||receipt[0]!.units!==centsToUnits(t.policy.amountCents))throw new Error('Payout receipt lacks the exact USDC transfer');
  return true;
 }
 return {
  market:()=>marketRail,
  async prepare(t){
   await safe();if(t.policy.paymentRail!=='base-usdc'||t.policy.currency!=='USD')throw new Error('Not a USDC task');
   let b=await get(t);
   if(!t.crypto){const start=(await c.getBlockNumber()).toString();const path=await view<string>('get_crypto_path',{id:t.id});t.crypto={startBlock:start,scanBlock:start,address:(await deriveEscrowAddress(path)).toLowerCase(),depositedUnits:'0',surplusUnits:'0'};store.save(t);}
   if(!b){await call(client,'create_crypto_bounty',{id:t.id,funding_hash:t.fundingPolicyHash,cents:t.policy.amountCents,verifier,escrow_address:t.crypto.address},'0.1');b=await get(t);}
   b=await match(t);
   // Deadline terms are recorded before any deposit address is shown, so they bind the funding.
   if(t.policy.market) await marketRail.configure(t);
   if(!b.address_verified){const key='crypto-address-retry:'+t.id;if(Date.now()-Number(portal.meta(key)||0)>60000){portal.meta(key,String(Date.now()));await call(client,'retry_crypto_address',{id:t.id});}return;}
   if(t.crypto.verifiedFundingHash!==t.fundingPolicyHash){t.crypto.verifiedFundingHash=t.fundingPolicyHash;store.save(t);}
   // Deadline bounties bind each assignment through the common lifecycle (bind_crypto_assignment).
   if(t.policy.market) return;
   if(t.policy.developerId && b.policy_hash===null){await call(b.verifier,'bind_crypto_recipient',{id:t.id,funding_hash:t.fundingPolicyHash,policy_hash:t.policyHash,recipient:t.policy.recipient});}
   else if(t.policy.developerId&&(b.policy_hash!==t.policyHash||b.recipient!==t.policy.recipient))throw new Error('Crypto recipient binding mismatch');
  },
  async sync(t){
   await safe();if(!t.crypto)return;let b=await match(t);if(!b.address_verified)return;
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
      if(!known){await call(relayer,'record_crypto_deposit',{id:t.id,units:entry.units.toString(),reference:entry.reference});
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
   t.disputed=b.disputed;
   if(b.payout && t.payment.state!=='Processed') await this.release(t);
  },
  async release(t){
   await safe();let b=await match(t);
   if(!t.evidence||t.verdict?.status!=='eligible'||!t.prNumber||t.policyHash!==hash(t.policy))throw new Error('Verified qualifying merge required for USDC release');
   if(b.policy_hash!==t.policyHash||b.recipient!==t.policy.recipient||b.disputed)throw new Error('Crypto release agreement mismatch');
   if(!b.payout){
    const fees=await c.estimateFeesPerGas();const max=fees.maxFeePerGas!,priority=fees.maxPriorityFeePerGas!;
    await ensureCryptoGas(portal,t.id,address(t.crypto!.address),120000n*max+1_000_000_000_000n);
    await call(b.verifier,'release_crypto_bounty',{id:t.id,policy_hash:t.policyHash,evidence_hash:t.verdict.evidenceHash,max_fee:max.toString(),priority_fee:priority.toString()});
    t.payment.state='Signing';t.payment.error=null;return;
   }
   if(b.payout.evidence_hash!==t.verdict.evidenceHash)throw new Error('Authorized crypto evidence changed; manual reconciliation required');
   if(!b.payout.signature){t.payment.state='Signing';if(Date.now()/1000>b.payout.signed_at_secs+900)await call(b.verifier,'retry_crypto_signature',{id:t.id});return;}
   const intentKey='crypto-payout:'+t.id;
   let intent=portal.meta(intentKey)?portal.open<{raw:Hex;hash:Hex}>(portal.meta(intentKey)!):null;
   if(!intent){intent=await signedPayout(b.payout.unsigned_tx,b.payout.signature,{escrow:t.crypto!.address,recipient:t.policy.recipient,cents:t.policy.amountCents});portal.meta(intentKey,portal.seal(intent));}
   if(keccak256(intent.raw)!==intent.hash)throw new Error('Payout journal integrity check failed');
   t.payment.state='Submitted';t.payment.reference=`https://sepolia.basescan.org/tx/${intent.hash}`;store.save(t);
   try{if(await confirmReceipt(intent.raw,intent.hash,t)){if(!b.payout.tx_hash)await call(relayer,'mark_crypto_processed',{id:t.id,tx_hash:intent.hash});else if(b.payout.tx_hash!==intent.hash)throw new Error('Processed payout hash mismatch');t.payment.state='Processed';t.payment.error=null;note(t,'USDC payout confirmed on Base Sepolia.');}}
   catch(error){if((error as Error).name==='TransactionReceiptNotFoundError'){try{await c.sendRawTransaction({serializedTransaction:intent.raw});}catch{/* Unknown broadcast outcome: retry same signed bytes only. */}return;}throw error;}
  },
  async dispute(t){await call(client,'dispute_crypto_bounty',{id:t.id});},
  async deposit(t){
   configured();if(t.policy.paymentRail!=='base-usdc'||t.policy.currency!=='USD')throw new Error('Not a USDC task');
   // Only cache an address after matching the immutable on-chain agreement and MPC verification.
   // Funding itself is still confirmed exclusively by the worker's live chain reconciliation.
   let depositAddress:string|null=null;
   if(t.policy.market && !(await view('get_crypto_market',{id:t.id}))) return {iban:null,reference:t.id,rail:'base-usdc',chainId:CHAIN_ID,token:USDC,address:null,amountUnits:centsToUnits(t.policy.amountCents).toString(),confirmations:12};
   if(t.crypto?.verifiedFundingHash){
    if(t.crypto.verifiedFundingHash!==t.fundingPolicyHash)throw new Error('Verified deposit instructions do not match the funding agreement');
    depositAddress=address(t.crypto.address);
   }else{await safe();const b=await match(t);depositAddress=b.address_verified?b.escrow_address:null;}
   return {iban:null,reference:t.id,rail:'base-usdc',chainId:CHAIN_ID,token:USDC,address:depositAddress,amountUnits:centsToUnits(t.policy.amountCents).toString(),confirmations:12};
  }
 };
}
