// Fresh testnet deployment only. Default: a public plan, no keys and no network calls.
// --prepare-keys creates local keys; --apply --confirm=<plan sha256> sends the reviewed transactions.
// Old storage is never upgraded. Root/deployer keys stay offline; only worker keys go to the VPS.
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Account,actions,KeyPair,nearToYocto,teraToGas,type KeyPairString} from 'near-api-js';
import bs58 from 'bs58';
import {env} from '../server/env.ts';
import {rpcProvider} from '../../../services/relayer/src/near.ts';
import {VERIFIER_METHODS,RELAYER_METHODS} from './testnet-scopes.ts';
const args=process.argv.slice(2),value=(name:string)=>args.find(a=>a.startsWith(name+'='))?.slice(name.length+1);
if(env.network!=='testnet')throw new Error('Testnet only');
const rail=value('--rail')??'usdc';if(!['usdc','bank'].includes(rail))throw new Error('Choose --rail=usdc or --rail=bank');
const rootDir=fileURLToPath(new URL('../../../',import.meta.url));
const directory=resolve(value('--directory')??join(rootDir,'data',`testnet-${rail}`));
const file=join(directory,'deployment.json'),keys=join(directory,'keys');
const previous=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
const root=value('--root')??previous?.plan.root??`np-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${randomBytes(3).toString('hex')}.testnet`;
if(!/^[a-z0-9-]{1,40}\.testnet$/.test(root))throw new Error('Use a fresh top-level .testnet root');
const wasmFile=value('--wasm');if(!wasmFile)throw new Error('Supply --wasm=<reviewed WASM file>. No keys or accounts were created.');
const wasm=readFileSync(resolve(wasmFile));
if(wasm.subarray(0,4).toString('hex')!=='0061736d')throw new Error('Invalid WASM artifact');
const codeHash=bs58.encode(createHash('sha256').update(wasm).digest());
const accounts={contract:`escrow.${root}`,client:`client.${root}`,verifier:`verifier.${root}`,relayer:`relayer.${root}`};
const contractStake=BigInt(wasm.length)*10n**19n+nearToYocto('0.7');
const balances={contract:contractStake.toString(),client:nearToYocto('1').toString(),verifier:nearToYocto('0.5').toString(),relayer:nearToYocto('0.5').toString()};
const plan={network:'testnet',rail,root,accounts,codeHash,wasmBytes:wasm.length,mpcContract:env.mpcContract,mpcPath:`nearportal-${rail}`,balancesYoctoNEAR:balances,minimumRootYoctoNEAR:(contractStake+nearToYocto('2.3')).toString(),verifierMethods:VERIFIER_METHODS[rail as 'usdc'|'bank'],relayerMethods:RELAYER_METHODS[rail as 'usdc'|'bank']};
const digest=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
if(previous && previous.digest!==digest)throw new Error('Deployment plan changed. Use a new directory and review its plan.');
mkdirSync(directory,{recursive:true,mode:0o700});chmodSync(directory,0o700);
const manifest=previous??{plan,digest,publicKeys:{},transactions:[],initialized:false};
const save=()=>{writeFileSync(file+'.tmp',JSON.stringify(manifest,null,2),{mode:0o600});renameSync(file+'.tmp',file);};
save();console.log(JSON.stringify({plan,digest,initialized:manifest.initialized},null,2));
const apply=args.includes('--apply');
if(apply&&value('--confirm')!==digest)throw new Error('Apply requires --confirm=<the exact reviewed plan digest>');
if(!apply&&!args.includes('--prepare-keys')){console.log('Plan only. No keys generated, network request, deployment or transfer.');process.exit(0);}
mkdirSync(keys,{recursive:true,mode:0o700});chmodSync(keys,0o700);
function pair(id:string){
 const path=join(keys,id+'.json');
 if(!existsSync(path)){const key=KeyPair.fromRandom('ed25519');writeFileSync(path,JSON.stringify({account_id:id,public_key:key.getPublicKey().toString(),private_key:key.toString()}),{mode:0o600,flag:'wx'});}
 const record=JSON.parse(readFileSync(path,'utf8'));const key=KeyPair.fromString(record.private_key as KeyPairString);
 if(record.account_id!==id||record.public_key!==key.getPublicKey().toString())throw new Error('Local key identity mismatch');
 manifest.publicKeys[id]=record.public_key;save();return key;
}
for(const id of [root,...Object.values(accounts)])pair(id);
console.log(JSON.stringify({root,publicKey:manifest.publicKeys[root],minimumRootYoctoNEAR:plan.minimumRootYoctoNEAR}));
if(!apply){console.log('Local keys prepared. No network request or funds moved.');process.exit(0);}
const provider=rpcProvider(env.nearRpc),owner=new Account(root,provider,pair(root).toString());
const state=async(id:string)=>{try{return await new Account(id,provider).getState();}catch(e){if(/UNKNOWN_ACCOUNT|does not exist/i.test(String(e)))return null;throw e;}};
// Root is funded separately, using the printed public key. Never debit another deployment.
const rootState=await state(root);if(!rootState)throw new Error('Create and fund the reviewed root account with its printed public key first.');
await owner.getAccessKey(pair(root).getPublicKey());
const receipt=(action:string,result:any)=>{manifest.transactions.push({action,hash:result.transaction.hash});save();console.log(`${action}: ${result.transaction.hash}`);};
for(const [role,id] of Object.entries(accounts)){
 const key=pair(id),methods=role==='verifier'?plan.verifierMethods:role==='relayer'?plan.relayerMethods:null;
 if(!(await state(id))){
  const amount=BigInt(balances[role as keyof typeof balances]);
  if((await owner.getState()).balance.available<amount+nearToYocto('0.1'))throw new Error('Insufficient test NEAR in the isolated root; existing progress is saved.');
  receipt(`create ${role}`,await owner.signAndSendTransaction({receiverId:id,actions:[actions.createAccount(),actions.transfer(amount),methods?actions.addFunctionCallAccessKey(key.getPublicKey(),accounts.contract,methods,nearToYocto('0.5')):actions.addFullAccessKey(key.getPublicKey())],waitUntil:'FINAL'}));
 }
 const access=await new Account(id,provider).getAccessKey(key.getPublicKey());
 if(methods){const fc=typeof access.permission==='object'?access.permission.FunctionCall:null;if(!fc||fc.receiver_id!==accounts.contract||JSON.stringify([...fc.method_names].sort())!==JSON.stringify([...methods].sort()))throw new Error(`${role} key scope mismatch`);}
 else if(access.permission!=='FullAccess')throw new Error(`${role} key permission mismatch`);
}
const contract=new Account(accounts.contract,provider,pair(accounts.contract).toString()),deployed=await contract.getState();
if(deployed.codeHash==='11111111111111111111111111111111')receipt('deploy and initialize',await contract.signAndSendTransaction({receiverId:accounts.contract,actions:[actions.deployContract(wasm),actions.functionCall('new',{owner:root,relayer:accounts.relayer,verifier:accounts.verifier,mpc_contract:env.mpcContract,mpc_path:plan.mpcPath},teraToGas('100'),0n)],waitUntil:'FINAL'}));
else if(deployed.codeHash!==codeHash)throw new Error('Existing contract code differs. In-place upgrades are prohibited by this tool.');
const view=()=>provider.callFunction({contractId:accounts.contract,method:'get_config',args:{}}) as Promise<any>;
let cfg=await view();
if(cfg.owner!==root||cfg.verifier!==accounts.verifier||cfg.relayer!==accounts.relayer||cfg.mpc_contract!==plan.mpcContract||cfg.mpc_path!==plan.mpcPath)throw new Error('Deployed configuration mismatch');
if(!cfg.operators.includes(accounts.client))receipt('authorize creator',await owner.signAndSendTransaction({receiverId:accounts.contract,actions:[actions.functionCall('set_operator',{operator:accounts.client,allowed:true},teraToGas('50'),0n)],waitUntil:'FINAL'}));
cfg=await view();if(cfg.operators.length!==1||cfg.operators[0]!==accounts.client||cfg.paused)throw new Error('Unexpected operator allowlist or pause');
if((await contract.getState()).codeHash!==codeHash)throw new Error('Deployed code hash mismatch');
manifest.initialized=true;save();
const settings=rail==='usdc'?{CRYPTO_ESCROW_CONTRACT_ID:accounts.contract,CRYPTO_CLIENT_ACCOUNT_ID:accounts.client,CRYPTO_VERIFIER_ACCOUNT_ID:accounts.verifier,CRYPTO_RELAYER_ACCOUNT_ID:accounts.relayer,CRYPTO_USDC_ENABLED:'1'}:{ESCROW_CONTRACT_ID:accounts.contract,CLIENT_ACCOUNT_ID:accounts.client,OWNER_ACCOUNT_ID:root,GITHUB_VERIFIER_ACCOUNT_ID:accounts.verifier,RELAYER_ACCOUNT_ID:accounts.relayer};
writeFileSync(join(directory,'public.env'),Object.entries(settings).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
console.log('Fresh contract deployed. No bounty, deposit, merge or payout was created. Keep root and contract keys offline; verify the E2E before enabling the website.');
