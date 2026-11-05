import test from 'node:test';import assert from 'node:assert/strict';
import {hash,type Task,type PrEvidence} from '../server/tasks/domain.ts';
import {ownerAcceptance,evaluateRelease} from '../server/tasks/owner-acceptance.ts';
const sha=(c:string)=>c.repeat(40);
function fixture(){
 const policy={version:1,title:'Receipts',criteria:['Receipts'],amountCents:100,currency:'USD',paymentRail:'base-usdc',repository:'owner/repo',repositoryId:1,branch:'main',developerId:2,developerLogin:'dev',mergerIds:[1],checks:[{name:'acceptance',appId:15368}],workflowPath:'.github/workflows/acceptance.yml',protectedFiles:[{path:'tests.ts',blobSha:'unchanged'}],baselineSha:sha('a'),mergeMethod:'squash',verifier:'verifier.testnet',recipient:'0x'+'1'.repeat(40)} as const;
 const t={id:'task',mode:'sandbox',githubMode:'live',ownerId:1,policy,policyHash:hash(policy),fundingPolicyHash:'b'.repeat(64),funded:true,fundedAt:'2026-11-04T10:00:00Z',clientAccepted:true,developerAccepted:true,prNumber:9,disputed:false,payment:{state:'NotRequested'}} as unknown as Task;
 const e={repositoryId:1,prNumber:9,authorId:2,branch:'main',headSha:sha('c'),mergeSha:sha('d'),merged:true,mergedById:1,mergedAt:'2026-11-04T11:00:00Z',mergeParents:[sha('a')],checks:[],runs:[],protectedFiles:[{path:'tests.ts',blobSha:'unchanged'}],observedAt:'2026-11-04T11:30:00Z'} as unknown as PrEvidence;
 const expected={policyHash:t.policyHash,headSha:e.headSha,mergeSha:e.mergeSha,prNumber:9};return{t,e,expected};
}
const accept=(f:ReturnType<typeof fixture>,owner=1)=>ownerAcceptance(f.t,f.e,owner,f.expected,'2026-11-04T12:00:00Z');
test('only explicit acceptance waives CI; original policy and missing checks remain intact',()=>{const f=fixture();assert.equal(evaluateRelease(f.t,f.e).status,'pending');const original=hash(f.t.policy);f.t.ownerAcceptance=accept(f);const v=evaluateRelease(f.t,f.e);assert.equal(v.status,'eligible');assert.equal(v.authorizationKind,'owner-acceptance');assert.equal(hash(f.t.policy),original);assert.equal(f.e.checks.length,0);assert.equal(f.t.policy.checks.length,1);assert.deepEqual(accept(f),f.t.ownerAcceptance);});
test('owner acceptance rejects wrong actor, live payment rail, altered pins and release state',()=>{
 const mutations=[(f:any)=>f.t.ownerId=3,(f:any)=>f.t.mode='simulation',(f:any)=>f.t.githubMode='fixture',(f:any)=>f.t.policy.paymentRail='bank',(f:any)=>f.t.payment.state='Authorized',(f:any)=>f.t.disputed=true,(f:any)=>f.t.funded=false,(f:any)=>f.expected.headSha=sha('e'),(f:any)=>f.expected.mergeSha=sha('e'),(f:any)=>f.expected.policyHash='x',(f:any)=>f.expected.prNumber=10];
 for(const mutate of mutations){const f=fixture();mutate(f);assert.throws(()=>accept(f));}assert.throws(()=>accept(fixture(),2));
});
test('acceptance retains author, repo, branch, merger, squash, protected-files and funding chronology gates',()=>{
 for(const mutate of [(e:any)=>e.merged=false,(e:any)=>e.authorId=3,(e:any)=>e.repositoryId=3,(e:any)=>e.branch='other',(e:any)=>e.mergedById=3,(e:any)=>e.mergeParents.push(sha('b')),(e:any)=>e.protectedFiles[0].blobSha='changed',(e:any)=>e.mergedAt='2026-11-04T09:00:00Z']){const f=fixture();mutate(f.e);assert.throws(()=>accept(f));}
});
test('stored acceptance fails closed on recipient, reward, policy or commit changes',()=>{
 for(const mutate of [(f:any)=>f.t.policy.recipient='0x'+'2'.repeat(40),(f:any)=>f.t.policy.amountCents=200,(f:any)=>f.e.headSha=sha('e'),(f:any)=>f.e.mergeSha=sha('e'),(f:any)=>f.t.ownerAcceptance.ownerId=3]){const f=fixture();f.t.ownerAcceptance=accept(f);mutate(f);assert.equal(evaluateRelease(f.t,f.e).status,'blocked');}
});
