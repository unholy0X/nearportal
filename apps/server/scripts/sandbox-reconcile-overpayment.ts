// Sandbox-only, receipt-audited recovery. Never sends additional EURe into an escrow.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Account, actions, teraToGas, type KeyPairString } from 'near-api-js';
import bs58 from 'bs58';
import { createPublicClient, http, erc20Abi, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { env, keyFor } from '../server/env.ts';
import { rpcProvider } from '../../../services/relayer/src/near.ts';
import { Monerium } from '../../../services/relayer/src/monerium.ts';
import { eurToCents, shortIban } from '../../../services/relayer/src/logic.ts';

if (env.network !== 'testnet' || !env.contractId.endsWith('.testnet') || env.monerium.api !== 'https://api.monerium.dev' || env.monerium.chain !== 'basesepolia') throw new Error('Isolated sandbox only');
const jobId = Number(process.argv.find(a => a.startsWith('--job='))?.slice(6));
if (!Number.isSafeInteger(jobId) || jobId < 0) throw new Error('Pass --job=<id>');
const apply = process.argv.includes('--apply');
const deployOnly = process.argv.includes('--deploy-only');
const provider = rpcProvider(env.nearRpc);
const view = <T=any>(method: string, args: Record<string,unknown> = {}) => provider.callFunction({contractId:env.contractId,method,args}) as Promise<T>;
const job = await view('get_job',{job_id:jobId});
const mandate = await view('get_open_bounty_mandate',{job_id:jobId});
if (!mandate || job.mediator !== env.mediator || job.client !== env.client || job.open_payouts !== 0 || job.state !== 'Signed' || job.deposited_cents !== 0 || job.excess_refunded_cents !== 0) throw new Error('Recovery requires an untouched, accepted open bounty with no payouts');
if (shortIban(process.env.TASK_CLIENT_IBAN || '') !== job.client_short_iban) throw new Error('Signed refund IBAN does not match client configuration');
const cfg = {moneriumApi:env.monerium.api,moneriumClientId:env.monerium.clientId,moneriumClientSecret:env.monerium.clientSecret,chain:env.monerium.chain} as any;
const monerium = new Monerium(cfg);
const receipts = (await monerium.ordersFor(job.escrow_evm_address)).filter(o => o.kind === 'issue' && o.state === 'processed');
const receiptCents = receipts.reduce((sum,o) => sum + eurToCents(o.amount),0);
if (new Set(receipts.map(o=>o.id)).size !== receipts.length || receiptCents !== job.excess_recorded_cents) throw new Error('Receipt totals do not match recorded excess');
const evm = createPublicClient({chain:baseSepolia,transport:http('https://sepolia.base.org')});
const tokens = await evm.readContract({address:'0x29F37F6adCa168B79B8d9567eab9BE3fBF21db85',abi:erc20Abi,functionName:'balanceOf',args:[job.escrow_evm_address as Address]});
if (tokens !== BigInt(receiptCents) * 10n ** 16n) throw new Error('Escrow token balance does not exactly match audited receipts');
const reward = job.milestones.reduce((sum:number,m:any)=>sum+m.amount_cents,0);
if (receiptCents <= reward) throw new Error('No surplus to recover');
const requestedRefund = process.argv.find(a => a.startsWith('--refund-short='))?.slice(15);
const refundAccounts = requestedRefund ? (await monerium.ibans()).filter(i => shortIban(i.iban) === requestedRefund && i.chain === env.monerium.chain) : [];
if (requestedRefund && refundAccounts.length !== 1) throw new Error('Refund destination must be exactly one IBAN belonging to the connected client profile');
const refundIban = refundAccounts[0]?.iban;
if (apply && !deployOnly && !refundIban) throw new Error('Confirm an owned Monerium refund IBAN with --refund-short before recovery');
const audit = {jobId,receiptIds:receipts.map(o=>o.id),receiptCents,rewardCents:reward,refundCents:receiptCents-reward,previousRefundShortIban:job.client_short_iban,refundShortIban:refundIban ? shortIban(refundIban) : job.client_short_iban,verifiedAt:new Date().toISOString(),upgradeHash:null as string|null,recoveryHash:null as string|null,payoutId:null as number|null};
console.log(JSON.stringify({apply,...audit}));
if (!apply) process.exit(0);
mkdirSync(`${env.dataDir}/sandbox`, { recursive: true, mode: 0o700 });
const auditFile=`${env.dataDir}/sandbox/overpayment-recovery-${jobId}.json`;
if (existsSync(auditFile)) throw new Error('Recovery journal already exists. Reconcile its transaction before another action');
if (!deployOnly) writeFileSync(auditFile,JSON.stringify(audit,null,2),{mode:0o600,flag:'wx'});
const config=await view('get_config');
const jobs=[];for(let id=0;id<config.next_job_id;id++)jobs.push(await view('get_job',{job_id:id}));
for(let id=0;id<config.next_payout_id;id++){const p=await view('get_payout',{payout_id:id});if(p.state!=='Processed')throw new Error('Resolve pending payouts before upgrading');}
const wasm=readFileSync(process.env.ESCROW_WASM??'../../contracts/escrow/target/wasm32-unknown-unknown/release/nearportal_escrow.wasm');
const codeHash=bs58.encode(createHash('sha256').update(wasm).digest());
const contract=new Account(env.contractId,provider,keyFor(env.contractId) as KeyPairString);
if ((await contract.getState()).codeHash !== codeHash) {
 const tx=await contract.signAndSendTransaction({receiverId:env.contractId,actions:[actions.deployContract(wasm)],waitUntil:'FINAL'});
 audit.upgradeHash=tx.transaction.hash;if (!deployOnly) writeFileSync(auditFile,JSON.stringify(audit,null,2),{mode:0o600});
}
for(let id=0;id<jobs.length;id++)if(JSON.stringify(await view('get_job',{job_id:id}))!==JSON.stringify(jobs[id]))throw new Error('Existing state changed during upgrade; stopping recovery');
const manifestPath = `${env.dataDir}/sandbox/deployment.json`;
if (existsSync(manifestPath)) { const manifest=JSON.parse(readFileSync(manifestPath,'utf8')); if(manifest.accounts.escrow!==env.contractId)throw new Error('Deployment manifest mismatch');manifest.codeHash=codeHash;if(audit.upgradeHash)manifest.transactions.push({action:'upgrade overpayment allocation and surplus refund',hash:audit.upgradeHash});writeFileSync(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600}); }
if (deployOnly) { console.log(JSON.stringify({upgradeHash:audit.upgradeHash,codeHash,jobsPreserved:jobs.length,fundsMoved:false})); process.exit(0); }
if (refundIban && audit.refundShortIban !== job.client_short_iban) {
 const client=new Account(env.client,provider,keyFor(env.client) as KeyPairString);
 await client.signAndSendTransaction({receiverId:env.contractId,actions:[actions.functionCall('update_unfunded_bounty_refund_iban',{job_id:jobId,short_iban:audit.refundShortIban},teraToGas('100'),0n)],waitUntil:'FINAL'});
 const updated=await view('get_job',{job_id:jobId});
 if (updated.client_short_iban !== audit.refundShortIban) throw new Error('Refund destination update failed');
 // Update only this job's local payee record, so the existing relayer can execute the signed refund.
 const { Store }=await import('../../../services/relayer/src/store.ts');
 const { DatabaseSync }=await import('node:sqlite');
 const db=new DatabaseSync(process.env.TASK_DB??`${env.dataDir}/github-tasks.sqlite`,{readOnly:true});
 const tasks=(db.prepare('SELECT body FROM tasks').all() as {body:string}[]).map(r=>JSON.parse(r.body));
 const task=tasks.find(t=>t.jobId===jobId);db.close();
 if (!task) throw new Error('No local bounty task for refund');
 const files=[`${env.dataDir}/github-relayer.json`,`${env.dataDir}/github-relayer-${task.ownerId}.json`];
 for(const file of files) { if(!existsSync(file))continue;const store=new Store(file);const rec=store.state.jobs[jobId];if(!rec)continue;rec.client={iban:refundIban,firstName:'Test',lastName:'Testsson',country:refundIban.slice(0,2)};store.save(); }
}
const mediator=new Account(env.mediator,provider,keyFor(env.mediator) as KeyPairString);
// One atomic, state-guarded call allocates the reward and schedules one surplus refund.
const tx=await mediator.signAndSendTransaction({receiverId:env.contractId,actions:[actions.functionCall('reconcile_bounty_overpayment', {job_id:jobId}, teraToGas('300'), 0n)],waitUntil:'FINAL'});
audit.recoveryHash=tx.transaction.hash;
const after=await view('get_job',{job_id:jobId});
const afterConfig=await view('get_config');
audit.payoutId=afterConfig.next_payout_id-1;
writeFileSync(auditFile,JSON.stringify(audit,null,2),{mode:0o600});
if(after.state!=='Funded'||after.deposited_cents!==reward||after.excess_refunded_cents!==receiptCents-reward)throw new Error('Recovery verification failed');
const p=await view('get_payout',{payout_id:audit.payoutId});
if(p.job_id!==jobId||p.amount_cents!==audit.refundCents||p.short_iban!==audit.refundShortIban||p.kind!=='ExcessRefund')throw new Error('Refund binding verification failed');
console.log(JSON.stringify({state:after.state,...audit,payoutState:p.state}));
