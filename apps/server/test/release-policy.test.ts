import test from 'node:test';import assert from 'node:assert/strict';
import {hash,type Task,type PrEvidence} from '../server/tasks/domain.ts';
import {evaluateRelease} from '../server/tasks/release-policy.ts';
const sha=(c:string)=>c.repeat(40);
function fixture(){
 const policy={version:1,title:'Receipts',criteria:['Receipts'],amountCents:100,currency:'USD',paymentRail:'base-usdc',repository:'owner/repo',repositoryId:1,branch:'main',developerId:2,developerLogin:'dev',mergerIds:[1],checks:[{name:'acceptance',appId:15368}],workflowPath:'.github/workflows/acceptance.yml',protectedFiles:[{path:'tests.ts',blobSha:'unchanged'}],baselineSha:sha('a'),mergeMethod:'squash',verifier:'verifier.testnet',recipient:'0x'+'1'.repeat(40)} as const;
 const t={id:'task',mode:'sandbox',githubMode:'live',ownerId:1,policy,policyHash:hash(policy),fundingPolicyHash:'b'.repeat(64),funded:true,fundedAt:'2026-11-04T10:00:00Z',clientAccepted:true,developerAccepted:true,prNumber:9,disputed:false,payment:{state:'NotRequested'}} as unknown as Task;
 const e={repositoryId:1,prNumber:9,authorId:2,branch:'main',headSha:sha('c'),mergeSha:sha('d'),merged:true,mergedById:1,mergedAt:'2026-11-04T11:00:00Z',mergeParents:[sha('a')],checks:[],runs:[],protectedFiles:[{path:'tests.ts',blobSha:'unchanged'}],observedAt:'2026-11-04T11:30:00Z'} as unknown as PrEvidence;
 const expected={policyHash:t.policyHash,headSha:e.headSha,mergeSha:e.mergeSha,prNumber:9};return{t,e,expected};
}
const passing = (f: ReturnType<typeof fixture>) => {
 f.e.checks = [{id:1,name:'acceptance',appId:15368,headSha:f.e.headSha,status:'completed',conclusion:'success',suiteId:1}];
 f.e.runs = [{id:1,headSha:f.e.headSha,path:'.github/workflows/acceptance.yml',suiteId:1,prNumbers:[9],conclusion:'success'}];
 return f;
};
test('a stored owner acceptance cannot waive missing or failed checks',()=>{
 for (const withFailedCheck of [false, true]) {
  const f=fixture();
  if(withFailedCheck){passing(f);f.e.checks[0]!.conclusion='failure';}
  Object.assign(f.t,{ownerAcceptance:{kind:'owner-acceptance',ownerId:1,...f.expected}});
  assert.notEqual(evaluateRelease(f.t,f.e).status,'eligible');
 }
});
test('passing checks still require creator merge, matching commit and protected files',()=>{
 assert.equal(evaluateRelease(passing(fixture()).t,passing(fixture()).e).status,'eligible');
 for(const mutate of [(e:any)=>e.merged=false,(e:any)=>e.mergedById=3,(e:any)=>e.authorId=3,(e:any)=>e.checks[0].headSha=sha('e'),(e:any)=>e.runs=[],(e:any)=>e.protectedFiles[0].blobSha='changed']){
  const f=passing(fixture());mutate(f.e);assert.notEqual(evaluateRelease(f.t,f.e).status,'eligible');
 }
});
