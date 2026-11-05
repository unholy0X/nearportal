import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {encodeEventTopics,encodeAbiParameters,encodeFunctionData,erc20Abi,serializeTransaction,keccak256,type Hex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {address,USDC,CHAIN_ID,centsToUnits,incomingTransfers,receiptReference,signedPayout,depositScanEnd} from '../server/crypto/evm.ts';
import {createWalletProof,verifyWalletProof} from '../server/crypto/wallet-proof.ts';
import {PortalStore} from '../server/portal/store.ts';
import {TaskStore} from '../server/tasks/store.ts';
const sender=privateKeyToAccount(('0x'+'07'.repeat(32)) as Hex),dest='0x1111111111111111111111111111111111111111';
const txHash=('0x'+'ab'.repeat(32)) as Hex,policy='a'.repeat(64);
const transfer=(to=dest,units=1000000n)=>({address:USDC,data:encodeAbiParameters([{type:'uint256'}],[units]),topics:encodeEventTopics({abi:erc20Abi,eventName:'Transfer',args:{from:sender.address,to:to as Hex}}),logIndex:2,transactionHash:txHash});
test('deposit scans respect the public RPC range and never skip a confirmed block',()=>{
 let next=1000n;const head=1510n,ranges=[];
 while(next<=head){const end=depositScanEnd(next,head);assert(end-next+1n<=200n);ranges.push([next,end]);next=end+1n;}
 assert.deepEqual(ranges,[[1000n,1199n],[1200n,1399n],[1400n,1510n]]);
 assert.equal(depositScanEnd(1510n,1510n),1510n);
 assert(depositScanEnd(1511n,1510n)<1511n);
});
test('pins Circle test USDC, six decimals, network and bounded integer rewards',()=>{
 assert.equal(USDC,'0x036cbd53842c5426634e7929541ec2318f3dcf7e');assert.equal(CHAIN_ID,84532);assert.equal(centsToUnits(100),1000000n);
 for(const n of [0,-1,1.5,100001,NaN])assert.throws(()=>centsToUnits(n));
 for(const a of ['0x'+'0'.repeat(40),USDC,'not-a-wallet'])assert.throws(()=>address(a));
});
test('manual deposit accepts any sender, tracks partials, ignores wrong token/recipient and removed logs',()=>{
 assert.equal(incomingTransfers([transfer()],dest)[0]!.units,1000000n);
 assert.equal(incomingTransfers([transfer(dest,400000n),transfer(dest,600000n)],dest).reduce((n,x)=>n+x.units,0n),1000000n);
 assert.equal(incomingTransfers([{...transfer(),address:dest},transfer(sender.address),{...transfer(),removed:true}],dest).length,0);
 assert.equal(receiptReference(txHash,2).length,81);assert.notEqual(receiptReference(txHash,2),receiptReference(txHash,3));
});
test('only exact signed fixed-USDC payout is accepted, never arbitrary calldata or another signer',async()=>{
 const tx={type:'eip1559' as const,chainId:84532,nonce:0,maxPriorityFeePerGas:1000000n,maxFeePerGas:1000000000n,gas:120000n,to:USDC,value:0n,data:encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[dest,1000000n]})};
 const unsigned=serializeTransaction(tx),signature=await sender.sign({hash:keccak256(unsigned)});
 const out=await signedPayout(unsigned,signature,{escrow:sender.address,recipient:dest,cents:100});assert.equal(out.hash,keccak256(out.raw));
 for(const patch of [{chainId:8453},{nonce:1},{to:dest},{value:1n},{gas:121000n},{data:'0x' as Hex}])await assert.rejects(()=>signedPayout(serializeTransaction({...tx,...patch}),signature,{escrow:sender.address,recipient:dest,cents:100}));
 await assert.rejects(()=>signedPayout(unsigned,signature,{escrow:dest,recipient:dest,cents:100}));
});
test('wallet proof binds GitHub identity, bounty, policy, address and one-use challenge',async()=>{
 const tasks=new TaskStore(':memory:'),store=new PortalStore(tasks.db,'',randomBytes(32));
 const challenge=createWalletProof(store,200,'bounty-id',policy,sender.address,'http://127.0.0.1:8787');
 const signature=await sender.signMessage({message:challenge.message});const body={walletAddress:sender.address,nonce:challenge.nonce,signature};
 await assert.rejects(()=>verifyWalletProof(store,201,'bounty-id',policy,body));
 await assert.rejects(()=>verifyWalletProof(store,200,'other-bounty',policy,body));
 await assert.rejects(()=>verifyWalletProof(store,200,'bounty-id','b'.repeat(64),body));
 await assert.rejects(()=>verifyWalletProof(store,200,'bounty-id',policy,{...body,walletAddress:dest}));
 const proof=await verifyWalletProof(store,200,'bounty-id',policy,body);proof.consume();await assert.rejects(()=>verifyWalletProof(store,200,'bounty-id',policy,body));tasks.close();
});

test('verified deposit address remains available offline without confirming funds',async()=>{
 const {cryptoPayments}=await import('../server/crypto/payments.ts');
 const keys=['CRYPTO_CLIENT_ACCOUNT_ID','CRYPTO_VERIFIER_ACCOUNT_ID','CRYPTO_RELAYER_ACCOUNT_ID','CRYPTO_ESCROW_CONTRACT_ID'];
 const prior=keys.map(k=>process.env[k]);const fetchBefore=globalThis.fetch;
 try{
  for(const [i,k] of keys.entries())process.env[k]=['client.crypto.testnet','verifier.crypto.testnet','relayer.crypto.testnet','escrow.crypto.testnet'][i];
  globalThis.fetch=async()=>{throw new Error('RPC unavailable');};
  const adapter=cryptoPayments({} as TaskStore,{} as PortalStore);
  const t={id:'81834579-7b9a-4a80-9de2-3d7fa8632fd0',policy:{paymentRail:'base-usdc',currency:'USD',amountCents:100},fundingPolicyHash:policy,crypto:{address:dest,verifiedFundingHash:policy},funded:false} as unknown as import('../server/tasks/domain.ts').Task;
  const result=await adapter.deposit(t) as unknown as {address:string;amountUnits:string};
  assert.equal(result.address,dest);assert.equal(result.amountUnits,'1000000');assert.equal(t.funded,false);
  t.crypto!.verifiedFundingHash='b'.repeat(64);
  await assert.rejects(()=>adapter.deposit(t),/do not match/);
 }finally{globalThis.fetch=fetchBefore;keys.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});}
});

test('crypto activity names the real rail while historical bank records remain unchanged',async()=>{
 const {TaskService}=await import('../server/tasks/service.ts');
 const old={at:'2026-11-04T15:19:00Z',message:'Monerium deposit confirmed in escrow.'};
 const t={policy:{paymentRail:'base-usdc'},timeline:[old]} as unknown as import('../server/tasks/domain.ts').Task;
 assert.equal(TaskService.prototype.public(t).timeline[0]!.message,'USDC deposit confirmed on Base Sepolia and recorded in NEAR escrow.');
 assert.equal(old.message,'Monerium deposit confirmed in escrow.');
 const bank={...t,policy:{...t.policy,paymentRail:undefined}};
 assert.equal(TaskService.prototype.public(bank).timeline[0]!.message,old.message);
});


test('scoped verifier rotation preserves only the explicitly configured legacy agreements', async () => {
 const {escrowVerifier}=await import('../server/crypto/verifier.ts');
 assert.equal(escrowVerifier('new.testnet','new.testnet','old.testnet',true),'new.testnet');
 assert.equal(escrowVerifier('old.testnet','new.testnet','old.testnet',false),'old.testnet');
 assert.throws(()=>escrowVerifier('old.testnet','new.testnet','old.testnet',true));
 assert.throws(()=>escrowVerifier('other.testnet','new.testnet','old.testnet',false));
 assert.throws(()=>escrowVerifier('old.testnet','new.testnet',undefined,false));
});
