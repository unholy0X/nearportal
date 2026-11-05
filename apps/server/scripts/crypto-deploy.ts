// Isolated testnet crypto deployment. Never upgrades the bank escrow or moves USDC.
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {Account,actions,KeyPair,nearToYocto,teraToGas,type KeyPairString} from 'near-api-js';
import bs58 from 'bs58';
import {env,keyFor} from '../server/env.ts';
import {rpcProvider} from '../../../services/relayer/src/near.ts';
if(env.network!=='testnet')throw new Error('Testnet deployment only');
const legacy=JSON.parse(readFileSync('data/sandbox/deployment.json','utf8'));
if(legacy.accounts.escrow!==env.contractId)throw new Error('Bank deployment mismatch');
const manifestFile=join(env.dataDir,'crypto-deployment.json');
const prior=existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')):null;
const root=(prior?.root ?? `nearportal-crypto-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomBytes(3).toString('hex')}.testnet`) as string, contract=`crypto.${root}`,client=`crypto-client.${root}`,verifier=`crypto-verifier.${root}`,relayer=`crypto-relayer.${root}`;
const wasm=readFileSync(resolve(process.env.USDC_ESCROW_WASM??'../../contracts/usdc-escrow/target/wasm32-unknown-unknown/release/nearportal_crypto_escrow.wasm'));
const codeHash=bs58.encode(createHash('sha256').update(wasm).digest());
const provider=rpcProvider(env.nearRpc);
if(!/^[a-z0-9-]+\.testnet$/.test(root))throw new Error('Invalid isolated root');
const contractStake=BigInt(wasm.length)*10n**19n+nearToYocto('0.7');
const accountNames={contract,client,verifier,relayer};
// Creating an escrow attaches 0.1 NEAR and reserves up to 300 Tgas (~0.3 NEAR).
// A 0.4 NEAR client balance leaves no room for transaction fees/storage.
const publicPlan={network:'testnet',root,accounts:accountNames,codeHash,wasmBytes:wasm.length,maximumNewAccountNEAR:Number(contractStake+nearToYocto('1.6'))/1e24};
console.log(JSON.stringify(publicPlan));
if(!prior){mkdirSync(env.dataDir,{recursive:true,mode:0o700});writeFileSync(manifestFile,JSON.stringify({...publicPlan,transactions:[]},null,2),{mode:0o600,flag:'wx'});}
if(!process.argv.includes('--apply')){console.log('Dry run only; public deployment plan saved. Pass --apply after code review.');process.exit(0);}
const directory=join(env.dataDir,'crypto-keys');mkdirSync(directory,{recursive:true,mode:0o700});
const manifest=existsSync(manifestFile)?JSON.parse(readFileSync(manifestFile,'utf8')):{...publicPlan,transactions:[]};
if(manifest.root!==root || JSON.stringify(manifest.accounts)!==JSON.stringify(accountNames) || manifest.codeHash!==codeHash)throw new Error('Existing crypto deployment differs; explicit reviewed upgrade required');
const save=()=>writeFileSync(manifestFile,JSON.stringify(manifest,null,2),{mode:0o600});save();
const receipt=(action:string,r:any)=>{manifest.transactions.push({action,hash:r.transaction.hash});save();console.log(action+': '+r.transaction.hash);};
function pair(id:string){const file=join(directory,id+'.json');if(!existsSync(file)){const k=KeyPair.fromRandom('ed25519');writeFileSync(file,JSON.stringify({account_id:id,public_key:k.getPublicKey().toString(),private_key:k.toString()}),{mode:0o600,flag:'wx'});}return KeyPair.fromString(JSON.parse(readFileSync(file,'utf8')).private_key);}
const owner=new Account(root,provider,pair(root).toString());
let rootState;try{rootState=await owner.getState();}catch(e){if(!/UNKNOWN_ACCOUNT|does not exist/i.test(String(e)))throw e;}
if(!rootState){
 const sponsor=await fetch("https://helper.testnet.near.org/account",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({newAccountId:root,newAccountPublicKey:pair(root).getPublicKey().toString()}),signal:AbortSignal.timeout(45000)});
 if(!sponsor.ok)throw new Error(`Testnet sponsorship failed (${sponsor.status}); saved public root is ${root}`);
 await sponsor.text();rootState=await owner.getState();
}
if(rootState.balance.available<contractStake+nearToYocto("1.7") && manifest.transactions.length===0)throw new Error(`Top up isolated ${root} with test NEAR before deployment`);
const methods:Record<string,string[]>={verifier:['bind_crypto_recipient','release_crypto_bounty','retry_crypto_signature','dispute_crypto_bounty'],relayer:['record_crypto_deposit','mark_crypto_processed']};
for(const [role,id] of Object.entries(accountNames)){
 const k=pair(id);let state;try{state=await new Account(id,provider).getState();}catch(e){if(!/UNKNOWN_ACCOUNT|does not exist/i.test(String(e)))throw e;}
 if(!state){const amount=role==='contract'?contractStake:nearToYocto(role==='client'?'0.8':'0.4');if((await owner.getState()).balance.available<amount+nearToYocto('0.1'))throw new Error('Insufficient root test NEAR; top up '+root);
  receipt('create crypto '+role,await owner.signAndSendTransaction({receiverId:id,actions:[actions.createAccount(),actions.transfer(amount),methods[role]?actions.addFunctionCallAccessKey(k.getPublicKey(),contract,methods[role]!,nearToYocto('0.4')):actions.addFullAccessKey(k.getPublicKey())],waitUntil:'FINAL'}));
 }
 const access=await new Account(id,provider).getAccessKey(k.getPublicKey());
 if(methods[role]){if(typeof access.permission!=='object'||access.permission.FunctionCall.receiver_id!==contract||JSON.stringify([...access.permission.FunctionCall.method_names].sort())!==JSON.stringify([...methods[role]!].sort()))throw new Error('Scoped crypto key mismatch');}
}
const chain=new Account(contract,provider,pair(contract).toString());const state=await chain.getState();
if(state.codeHash==='11111111111111111111111111111111')receipt('deploy isolated crypto escrow',await chain.signAndSendTransaction({receiverId:contract,actions:[actions.deployContract(wasm),actions.functionCall('new',{owner:root,relayer,mpc_contract:env.mpcContract,mpc_path:'nearportal-crypto-v1'},teraToGas('100'),0n)],waitUntil:'FINAL'}));
else if(state.codeHash!==codeHash)throw new Error('Existing crypto code differs; explicit reviewed upgrade required');
const config=await provider.callFunction({contractId:contract,method:'get_config',args:{}}) as any;
if(config.owner!==root||config.relayer!==relayer||config.mpc_contract!==env.mpcContract||config.mpc_path!=='nearportal-crypto-v1')throw new Error('Crypto chain configuration mismatch');
const operator=await provider.callFunction({contractId:contract,method:'get_crypto_operator',args:{}});
if(!operator)receipt('authorize crypto operator',await owner.signAndSendTransaction({receiverId:contract,actions:[actions.functionCall('set_crypto_operator',{operator:client,verifier},teraToGas('50'),0n)],waitUntil:'FINAL'}));
else if(JSON.stringify(operator)!==JSON.stringify([client,verifier]))throw new Error('Crypto operator differs');
const settings={CRYPTO_ESCROW_CONTRACT_ID:contract,CRYPTO_CLIENT_ACCOUNT_ID:client,CRYPTO_VERIFIER_ACCOUNT_ID:verifier,CRYPTO_RELAYER_ACCOUNT_ID:relayer,CRYPTO_USDC_ENABLED:'1'};
let dotenv=readFileSync('.env.sandbox','utf8');for(const [k,v] of Object.entries(settings)){dotenv=dotenv.replace(new RegExp('^'+k+'=.*\\n?','m'),'');dotenv+='\n'+k+'='+v+'\n';}writeFileSync('.env.sandbox',dotenv,{mode:0o600});
manifest.codeHash=codeHash;manifest.initialized=true;save();console.log('Isolated crypto testnet escrow ready. Bank contract unchanged; no USDC moved.');
