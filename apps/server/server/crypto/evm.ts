import { createPublicClient, http, erc20Abi, decodeEventLog, encodeFunctionData, serializeTransaction, keccak256, recoverTransactionAddress, type Hex, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
export const CHAIN_ID = 84532;
// Circle's Base Sepolia testnet USDC, https://developers.circle.com/stablecoins/usdc-contract-addresses
export const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e' as Address;
export const RPC = 'https://sepolia.base.org';
// The public Base Sepolia RPC rejects eth_getLogs requests spanning >200 blocks.
export function depositScanEnd(from: bigint, confirmedHead: bigint): bigint {
  return from + 199n < confirmedHead ? from + 199n : confirmedHead;
}
export const publicClient = () => createPublicClient({ chain: baseSepolia, transport: http(process.env.CRYPTO_BASE_RPC || RPC,{timeout:15000,retryCount:0}) });
export function address(value: unknown): Address {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value) || value.toLowerCase()===USDC) throw new Error('Enter a Base Sepolia wallet address');
  return value.toLowerCase() as Address;
}
export function centsToUnits(cents: number) {
  if (!Number.isSafeInteger(cents)||cents<1||cents>100000) throw new Error('USDC test rewards must be 0.01–1,000 USDC');
  return BigInt(cents)*10000n;
}
export function receiptReference(hash: Hex, index: number) {
  if (!/^0x[0-9a-f]{64}$/i.test(hash)||!Number.isSafeInteger(index)||index<0||index>0xffffffff) throw new Error('Invalid transfer reference');
  return `${CHAIN_ID}:${hash.toLowerCase()}:${index.toString(16).padStart(8,'0')}`;
}
export function incomingTransfers(logs: {address:string;data:Hex;topics:readonly Hex[];logIndex:number|null;transactionHash:Hex|null;removed?:boolean}[], target: string) {
  const result: {units:bigint;reference:string}[]=[];
  for(const log of logs) {
    if(log.removed || log.address.toLowerCase()!==USDC || log.logIndex===null || !log.transactionHash) continue;
    try {
      const e=decodeEventLog({abi:erc20Abi,eventName:'Transfer',data:log.data,topics:log.topics as [Hex,...Hex[]]});
      if(e.args.to.toLowerCase()===target.toLowerCase() && e.args.value>0n) result.push({units:e.args.value,reference:receiptReference(log.transactionHash,log.logIndex)});
    } catch { /* An unrelated event cannot credit funding. */ }
  }
  return result;
}
export async function signedPayout(unsigned: Hex, signature: Hex, expected: {escrow:string;recipient:string} & ({cents:number;units?:never}|{units:bigint;cents?:never})) {
  const {parseTransaction}=await import('viem');
  const tx=parseTransaction(unsigned);
  const units=expected.units??centsToUnits(expected.cents!);
  if(units<=0n||units>0xffff_ffff_ffff_ffffn)throw new Error('Invalid authorized USDC amount');
  const expectedData=encodeFunctionData({abi:erc20Abi,functionName:'transfer',args:[address(expected.recipient),units]});
  if(tx.type!=='eip1559'||tx.chainId!==CHAIN_ID||tx.nonce!==0||tx.to?.toLowerCase()!==USDC||tx.value!==undefined&&tx.value!==0n||tx.data!==expectedData||tx.gas!==120000n||!tx.maxFeePerGas||tx.maxFeePerGas>100000000000n||tx.maxPriorityFeePerGas===undefined||tx.maxPriorityFeePerGas>tx.maxFeePerGas) throw new Error('Contract payout transaction does not match the accepted USDC agreement');
  if(!/^0x[0-9a-f]{130}$/i.test(signature)) throw new Error('Invalid MPC signature');
  const v=Number.parseInt(signature.slice(-2),16);
  if(v!==27&&v!==28) throw new Error('Invalid recovery id');
  const raw=serializeTransaction(tx,{r:signature.slice(0,66) as Hex,s:('0x'+signature.slice(66,130)) as Hex,yParity:(v-27) as 0|1});
  if((await recoverTransactionAddress({serializedTransaction:raw})).toLowerCase()!==expected.escrow.toLowerCase()) throw new Error('MPC signature belongs to another escrow');
  return {raw,hash:keccak256(raw)};
}
