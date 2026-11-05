// Reviewed USDC testnet upgrade only. Dry run by default; never transfers USDC.
import {readFileSync,writeFileSync,existsSync,mkdirSync,copyFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Account,actions,KeyPair,nearToYocto,teraToGas} from 'near-api-js';
import bs58 from 'bs58';
process.env.ENV_FILE ??= '.env.sandbox';
const {env}=await import('../server/env.ts');
const {rpcProvider}=await import('../../../services/relayer/src/near.ts');
if(env.network!=='testnet')throw Error('Testnet only');
const file=join(env.dataDir,'crypto-deployment.json'), manifest=JSON.parse(readFileSync(file,'utf8'));
const contract=process.env.CRYPTO_ESCROW_CONTRACT_ID!,client=process.env.CRYPTO_CLIENT_ACCOUNT_ID!,old=process.env.CRYPTO_LEGACY_VERIFIER_ACCOUNT_ID || process.env.CRYPTO_VERIFIER_ACCOUNT_ID!;
if(contract!==manifest.accounts.contract||client!==manifest.accounts.client||!contract.endsWith('.testnet'))throw Error('Deployment identity mismatch');
const verifier=`deadline-verifier.${manifest.root}`;
const methods=['bind_crypto_recipient','release_crypto_bounty','retry_crypto_signature','dispute_crypto_bounty','bind_crypto_assignment','record_crypto_submission','withdraw_crypto_assignment','expire_crypto_assignment'];
const wasm=readFileSync(resolve(process.env.USDC_ESCROW_REVIEWED_WASM??'../../contracts/usdc-escrow/target/deadline-reviewed.wasm'));
const hash=bs58.encode(createHash('sha256').update(wasm).digest());
const provider=rpcProvider(env.nearRpc);
const view=<T>(method:string,args:Record<string,unknown>={})=>provider.callFunction({contractId:contract,method,args}) as Promise<T>;
const root=manifest.root as string;
const keyDir=join(env.dataDir,'crypto-keys');
function key(id:string){if(![root,contract,verifier].includes(id))throw Error('Unapproved signer');return KeyPair.fromString(JSON.parse(readFileSync(join(keyDir,id+'.json'),'utf8')).private_key);}
function account(id:string){return new Account(id,provider,key(id).toString());}
const db=new DatabaseSync(join(env.dataDir,'github-tasks.sqlite'),{readOnly:true});
const tasks=(db.prepare('SELECT body FROM tasks').all() as {body:string}[]).map(r=>JSON.parse(r.body)).filter(t=>t.policy.paymentRail==='base-usdc');db.close();
const before=new Map<string,unknown>();
for(const t of tasks){const b=await view<any>('get_crypto_bounty',{id:t.id});if(b?.payout&&!b.payout.tx_hash)throw Error('An authorized USDC payout needs reconciliation before upgrade');if(t.payment.state!=='NotRequested'&&t.payment.state!=='Processed')throw Error('A USDC payment is pending; reconcile it before upgrade');before.set(t.id,b);}
const config=await view('get_config'),operator=await view<[string,string]>('get_crypto_operator');
if(operator[0]!==client||![old,verifier].includes(operator[1]))throw Error('Unexpected existing operator');
const current=await new Account(contract,provider).getState();
const publicPlan={network:'testnet',contract,currentCodeHash:current.codeHash,reviewedCodeHash:hash,verifier,legacyVerifier:old,methods,existingBounties:before.size,wasmBytes:wasm.length,testNEARForVerifier:'0.5',movesUSDC:false};
console.log(JSON.stringify(publicPlan,null,2));
if(!process.argv.includes('--apply'))process.exit(0);
const out=resolve(process.env.AUDIT_DIR??'output/deadline-activation');mkdirSync(out,{recursive:true,mode:0o700});
const journalFile=join(out,'upgrade.json');
const journal=existsSync(journalFile)?JSON.parse(readFileSync(journalFile,'utf8')):{...publicPlan,transactions:[]};
if(journal.reviewedCodeHash!==hash||journal.contract!==contract)throw Error('Reviewed upgrade differs from journal');
const save=()=>writeFileSync(journalFile,JSON.stringify(journal,null,2),{mode:0o600});save();
const privateBackup=join(env.dataDir,'deadline-upgrade-backup');mkdirSync(privateBackup,{recursive:true,mode:0o700});
if(!existsSync(join(privateBackup,'env-before')))copyFileSync('.env.sandbox',join(privateBackup,'env-before'));
if(!existsSync(join(out,'state-before.json')))writeFileSync(join(out,'state-before.json'),JSON.stringify({config,operator,bounties:Object.fromEntries(before)},null,2),{mode:0o600});
if(!existsSync(join(out,'contract-before.wasm'))){
 const r=await fetch(env.nearRpc.split(',')[0]!,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:'backup',method:'query',params:{request_type:'view_code',account_id:contract,finality:'final'}})});
 const data=await r.json() as any;if(!data.result?.code_base64)throw Error('Cannot back up existing WASM');writeFileSync(join(out,'contract-before.wasm'),Buffer.from(data.result.code_base64,'base64'),{mode:0o600});
}
const receipt=(action:string,r:any)=>{journal.transactions.push({action,hash:r.transaction.hash});save();console.log(`${action}: ${r.transaction.hash}`);};
const owner=account(root),chain=account(contract);
let verifierState;try{verifierState=await new Account(verifier,provider).getState();}catch(e){if(!/UNKNOWN_ACCOUNT|does not exist/i.test(String(e)))throw e;}
const keyFile=join(keyDir,verifier+'.json');
if(!verifierState){if(!existsSync(keyFile)){const pair=KeyPair.fromRandom('ed25519');writeFileSync(keyFile,JSON.stringify({account_id:verifier,public_key:pair.getPublicKey().toString(),private_key:pair.toString()}),{mode:0o600,flag:'wx'});}
 receipt('create scoped deadline verifier',await owner.signAndSendTransaction({receiverId:verifier,actions:[actions.createAccount(),actions.transfer(nearToYocto('0.5')),actions.addFunctionCallAccessKey(key(verifier).getPublicKey(),contract,methods,nearToYocto('0.4'))],waitUntil:'FINAL'}));
}
const access=await new Account(verifier,provider).getAccessKey(key(verifier).getPublicKey());
if(typeof access.permission!=='object'||access.permission.FunctionCall.receiver_id!==contract||JSON.stringify([...access.permission.FunctionCall.method_names].sort())!==JSON.stringify([...methods].sort()))throw Error('Verifier scope differs from reviewed plan');
if((await chain.getState()).codeHash!==hash)receipt('upgrade USDC deadline contract',await chain.signAndSendTransaction({receiverId:contract,actions:[actions.deployContract(wasm)],waitUntil:'FINAL'}));
for(const [id,b] of before){if(JSON.stringify(await view('get_crypto_bounty',{id}))!==JSON.stringify(b))throw Error('Existing USDC bounty changed during upgrade');}
if(JSON.stringify(await view('get_config'))!==JSON.stringify(config))throw Error('Contract config changed');
if(await view('get_crypto_market',{id:'00000000-0000-0000-0000-000000000000'})!==null)throw Error('Unexpected market probe');
if((await view<[string,string]>('get_crypto_operator'))[1]!==verifier)receipt('authorize new scoped verifier',await owner.signAndSendTransaction({receiverId:contract,actions:[actions.functionCall('set_crypto_operator',{operator:client,verifier},teraToGas('50'),0n)],waitUntil:'FINAL'}));
let dotenv=readFileSync('.env.sandbox','utf8');
for(const [k,v] of Object.entries({CRYPTO_VERIFIER_ACCOUNT_ID:verifier,CRYPTO_LEGACY_VERIFIER_ACCOUNT_ID:old})){dotenv=dotenv.replace(new RegExp('^'+k+'=.*\\n?','m'),'');dotenv+='\n'+k+'='+v+'\n';}
writeFileSync('.env.sandbox',dotenv,{mode:0o600});
manifest.codeHash=hash;manifest.accounts.verifier=verifier;manifest.legacyVerifier=old;manifest.transactions.push(...journal.transactions.filter((t:any)=>!manifest.transactions.some((m:any)=>m.hash===t.hash)));writeFileSync(file,JSON.stringify(manifest,null,2),{mode:0o600});
journal.stateUnchanged=true;journal.deployedCodeHash=(await chain.getState()).codeHash;save();
console.log('USDC deadline contract and scoped key verified; existing bounties unchanged. Rollout gate remains closed pending pilot verification.');
