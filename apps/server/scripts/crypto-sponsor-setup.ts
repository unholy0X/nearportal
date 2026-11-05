// Native test ETH only. Separate gas-only key; never sends EURe or USDC.
import {createConnection} from 'node:net';
import {createWalletClient,http,keccak256,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {baseSepolia} from 'viem/chains';
import {env} from '../server/env.ts';
import {TaskStore} from '../server/tasks/store.ts';
import {PortalStore} from '../server/portal/store.ts';
import {gasSponsor} from '../server/crypto/gas.ts';
import {publicClient,RPC,CHAIN_ID} from '../server/crypto/evm.ts';
if(env.network!=='testnet')throw new Error('Testnet only');
const tasks=new TaskStore(`${env.dataDir}/github-tasks.sqlite`),store=new PortalStore(tasks.db,env.dataDir),sponsor=gasSponsor(store),c=publicClient();
if(await c.getChainId()!==CHAIN_ID)throw new Error('Base Sepolia required');
console.log(JSON.stringify({gasSponsor:sponsor.address,testETHWei:String(await c.getBalance({address:sponsor.address})),action:'Optional one-time 0.00003 test ETH seed from existing demo wallet; no tokens move'}));
if(process.argv.includes('--fund-from-demo')){
 const listening=await new Promise<boolean>(resolve=>{const s=createConnection({host:'127.0.0.1',port:8787});s.once('connect',()=>{s.end();resolve(true);});s.once('error',()=>resolve(false));});
 if(listening)throw new Error('Stop the local backend before seeding sponsor to prevent demo-wallet nonce races');
 const row=store.meta('demo-treasury-key');if(!row)throw new Error('No existing demo treasury');const account=privateKeyToAccount(store.open<{key:Hex}>(row).key);
 const journal='crypto-sponsor-seed';let intent=store.meta(journal)?store.open<{raw:Hex;hash:Hex}>(store.meta(journal)!):null;
 if(!intent){
  const latest=await c.getTransactionCount({address:account.address,blockTag:'latest'}),pending=await c.getTransactionCount({address:account.address,blockTag:'pending'});if(latest!==pending)throw new Error('Demo wallet has a pending transaction; reconcile before seeding');
  const value=30_000_000_000_000n;if(await c.getBalance({address:account.address})<value*2n)throw new Error('Insufficient demo-wallet test ETH reserve');
  const wallet=createWalletClient({account,chain:baseSepolia,transport:http(process.env.CRYPTO_BASE_RPC||RPC,{timeout:10000,retryCount:0})});
  const req=await wallet.prepareTransactionRequest({type:'eip1559',account,chain:baseSepolia,to:sponsor.address,value,nonce:pending});
  const raw=await account.signTransaction(req);intent={raw,hash:keccak256(raw)};store.meta(journal,store.seal(intent));
 }
 try{const r=await c.getTransactionReceipt({hash:intent.hash});if(r.status!=='success')throw new Error('Sponsor seed reverted; manual review required');console.log(JSON.stringify({seedHash:intent.hash,status:'confirmed',testETHWei:String(await c.getBalance({address:sponsor.address}))}));}
 catch(e){if((e as Error).name!=='TransactionReceiptNotFoundError')throw e;try{await c.sendRawTransaction({serializedTransaction:intent.raw});}catch{/* Same frozen transaction on every retry. */}console.log(JSON.stringify({seedHash:intent.hash,status:'submitted; rerun to reconcile the same transaction'}));}
}
tasks.close();
