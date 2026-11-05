import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {createWalletClient,http,keccak256,parseTransaction,recoverTransactionAddress,type Hex,type Address} from 'viem';
import {baseSepolia} from 'viem/chains';
import type {PortalStore} from '../portal/store.ts';
import {PaymentPending} from '../tasks/payment-pending.ts';
import {publicClient,RPC,CHAIN_ID} from './evm.ts';
const ALLOCATION=10_000_000_000_000n; // 0.00001 test ETH, from a separate gas-only sponsor.
export function gasSponsor(store:PortalStore) {
 let sealed=store.meta('crypto-sponsor-key');
 if(!sealed) {
   store.db.prepare("INSERT OR IGNORE INTO portal_meta(key,value) VALUES('crypto-sponsor-key',?)").run(store.seal({key:generatePrivateKey()}));
   sealed=store.meta('crypto-sponsor-key')!;
 }
 const account=privateKeyToAccount(store.open<{key:Hex}>(sealed).key);
 return {address:account.address,key:account};
}
/** Recheck shared state after async nonce/fee preparation, before any broadcast. */
export function commitGasIntent(store:PortalStore,id:string,intent:{raw:Hex;hash:Hex},day:string) {
 store.db.exec('BEGIN IMMEDIATE');
 try {
   if(store.meta('crypto-gas-active') || store.meta('crypto-gas:'+id))throw new PaymentPending('Gas sponsor changed while preparing; reconcile the existing journal');
   const count=Number(store.meta('crypto-gas-count:'+day)||0);
   if(!Number.isSafeInteger(count)||count<0||count>=10)throw new Error('Daily crypto test gas sponsorship limit reached');
   store.meta('crypto-gas:'+id,store.seal(intent));store.meta('crypto-gas-active',id);store.meta('crypto-gas-count:'+day,String(count+1));
   store.db.exec('COMMIT');
 }catch(error){store.db.exec('ROLLBACK');throw error;}
}
export async function ensureCryptoGas(store:PortalStore,id:string,destination:Address,needed:bigint) {
 const c=publicClient();if(await c.getChainId()!==CHAIN_ID)throw new Error('Gas sponsor requires Base Sepolia');
 if(needed>ALLOCATION)throw new Error('Base test gas estimate exceeds sponsor limit; wait for lower fees');
 if(await c.getBalance({address:destination})>=needed && store.meta("crypto-gas-active")!==id)return;
 const sponsor=gasSponsor(store),wallet=createWalletClient({account:sponsor.key,chain:baseSepolia,transport:http(process.env.CRYPTO_BASE_RPC||RPC,{timeout:15000,retryCount:0})});
 const meta='crypto-gas:'+id;
 let intent=store.meta(meta)?store.open<{raw:Hex;hash:Hex}>(store.meta(meta)!):null;
 if(!intent){
   // Workers can overlap. The transaction below admits only one persisted sponsor intent.
   const active=store.meta('crypto-gas-active');if(active && active!==id)throw new PaymentPending('Gas sponsor is reconciling another escrow');
   const day=new Date().toISOString().slice(0,10),count=Number(store.meta('crypto-gas-count:'+day)||0);
   if(count>=10)throw new Error('Daily crypto test gas sponsorship limit reached');
   if(await c.getBalance({address:sponsor.address})<ALLOCATION+needed)throw new Error(`Top up the Base Sepolia gas-only sponsor ${sponsor.address} with test ETH before crypto payouts`);
   const req=await wallet.prepareTransactionRequest({type:"eip1559",account:sponsor.key,chain:baseSepolia,to:destination,value:ALLOCATION,nonce:await c.getTransactionCount({address:sponsor.address,blockTag:'pending'})});
   const raw=await sponsor.key.signTransaction(req);intent={raw,hash:keccak256(raw)};
   commitGasIntent(store,id,intent,day);
 }
 const frozen=parseTransaction(intent.raw);
 if(keccak256(intent.raw)!==intent.hash || frozen.chainId!==CHAIN_ID || frozen.to?.toLowerCase()!==destination.toLowerCase() || frozen.value!==ALLOCATION || (await recoverTransactionAddress({serializedTransaction:intent.raw as `0x02${string}`})).toLowerCase()!==sponsor.address.toLowerCase())throw new Error("Gas journal does not match this escrow");
 try{const r=await c.getTransactionReceipt({hash:intent.hash});if(r.from.toLowerCase()!==sponsor.address.toLowerCase() || r.to?.toLowerCase()!==destination.toLowerCase())throw new Error("Gas receipt does not match sponsor and escrow");if(r.status!=='success')throw new Error('Gas sponsorship reverted; manual reconciliation required');if(await c.getBlockNumber()-r.blockNumber<12n)throw new PaymentPending('Waiting for gas sponsorship confirmations');const block=await c.getBlock({blockNumber:r.blockNumber});if(block.hash!==r.blockHash)throw new Error('Gas receipt is not canonical');store.db.prepare("UPDATE portal_meta SET value='' WHERE key='crypto-gas-active' AND value=?").run(id);if(await c.getBalance({address:destination})<needed)throw new Error('Escrow test ETH is insufficient; manual gas top-up required');}
 catch(error){if((error as Error).name==='TransactionReceiptNotFoundError'){try{await c.sendRawTransaction({serializedTransaction:intent.raw});}catch{/* Always reconcile the same frozen bytes. */}throw new PaymentPending('Gas sponsorship submitted; awaiting confirmation');}throw error;}
}
