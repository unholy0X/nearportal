// Read-only verification of the selected fresh testnet deployment. No key material is loaded.
import '../../server/env.ts';
import {VERIFIER_METHODS,RELAYER_METHODS} from '../testnet-scopes.ts';
import {USDC,CHAIN_ID} from '../../server/crypto/evm.ts';
const config=process.env;
if((config.NEAR_NETWORK??'testnet')!=='testnet')throw new Error('Preflight is for NEAR testnet only');
const rpc=(config.NEAR_RPC??'https://rpc.testnet.near.org').split(',')[0]!.trim();
async function query(params:Record<string,unknown>){
 const response=await fetch(rpc,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'preflight',method:'query',params:{finality:'final',...params}}),signal:AbortSignal.timeout(15_000)});
 if(!response.ok)throw new Error('RPC unavailable');
 const body=await response.json() as any;if(body.error||!body.result||body.result.error)throw new Error('RPC query failed');return body.result;
}
async function view(account:string,method:string,args:unknown={}){const result=await query({request_type:'call_function',account_id:account,method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});return JSON.parse(Buffer.from(result.result).toString());}
const verified=(config.MARKET_VERIFIED_CODE_HASHES??'').split(',').map(s=>s.trim()).filter(Boolean);
const rails=[
 {name:'bank',contract:config.ESCROW_CONTRACT_ID,client:config.CLIENT_ACCOUNT_ID,verifier:config.GITHUB_VERIFIER_ACCOUNT_ID,relayer:config.RELAYER_ACCOUNT_ID},
 {name:'usdc',contract:config.CRYPTO_ESCROW_CONTRACT_ID,client:config.CRYPTO_CLIENT_ACCOUNT_ID,verifier:config.CRYPTO_VERIFIER_ACCOUNT_ID,relayer:config.CRYPTO_RELAYER_ACCOUNT_ID},
] as const;
const selected=process.argv.includes('--usdc-only')?rails.filter(r=>r.name==='usdc'):rails;
const report:any={network:'testnet',rails:[]};
for(const rail of selected){
 const row:any={rail:rail.name,contract:rail.contract??null,ready:false};report.rails.push(row);
 try{
  if(!rail.contract?.endsWith('.testnet')||!rail.client||!rail.verifier||!rail.relayer)throw new Error('Missing testnet role configuration');
  const state=await query({request_type:'view_account',account_id:rail.contract});row.codeHash=state.code_hash;row.codeHashVerified=verified.includes(state.code_hash);
  const cfg=await view(rail.contract,'get_config');
  row.rolesMatch=cfg.verifier===rail.verifier&&cfg.relayer===rail.relayer&&cfg.operators.length===1&&cfg.operators[0]===rail.client&&new Set([cfg.owner,rail.verifier,rail.client,rail.relayer]).size===4;
  row.unpaused=cfg.paused===false;
  row.railMatches=rail.name==='bank'||(cfg.chain_id===String(CHAIN_ID)&&cfg.token===USDC);
  row.interfaceMatches=await view(rail.contract,'get_bounty',{bounty_id:rail.name==='bank'?'18446744073709551615':'00000000-0000-0000-0000-000000000000'})===null;
  row.scopedKeys={};
  for(const role of ['verifier','relayer'] as const){
   const keys=(await query({request_type:'view_access_key_list',account_id:rail[role]})).keys;
   const expected=role==='verifier'?VERIFIER_METHODS[rail.name]:RELAYER_METHODS[rail.name];
   row.scopedKeys[role]=keys.length===1&&keys.every((k:any)=>{const fc=k.access_key.permission?.FunctionCall;return fc&&fc.receiver_id===rail.contract&&JSON.stringify([...fc.method_names].sort())===JSON.stringify([...expected].sort())&&fc.allowance!==null&&BigInt(fc.allowance)>0n;});
  }
  row.ready=row.codeHashVerified&&row.rolesMatch&&row.unpaused&&row.railMatches&&row.interfaceMatches&&row.scopedKeys.verifier&&row.scopedKeys.relayer;
 }catch(error){row.error=error instanceof Error&&['Missing testnet role configuration','RPC unavailable','RPC query failed'].includes(error.message)?error.message:'Unable to verify this deployment';}
}
console.log(JSON.stringify(report,null,2));
process.exitCode=report.rails.every((r:any)=>r.ready)?0:1;
