import { evaluate, hash, type Task, type PrEvidence, type Verdict } from './domain.ts';
import { evaluateMergePolicy } from './merge-policy.ts';
export interface OwnerAcceptance {
 kind:'owner-acceptance';ownerId:number;policyHash:string;fundingPolicyHash:string;prNumber:number;headSha:string;mergeSha:string;bindingHash:string;acceptedAt:string;
}
const binding=(t:Task)=>hash({recipient:t.policy.recipient,cents:t.policy.amountCents,currency:t.policy.currency,fundingPolicyHash:t.fundingPolicyHash});
function assertAcceptance(t:Task,e:PrEvidence,a:OwnerAcceptance){
 if(t.mode!=='sandbox'||t.githubMode!=='live'||t.policy.paymentRail!=='base-usdc')throw new Error('Owner acceptance is available only for live testnet USDC bounties');
 if(!t.ownerId||a.ownerId!==t.ownerId||!t.policy.mergerIds.includes(a.ownerId))throw new Error('Only the bounty owner can accept this work');
 if(!t.clientAccepted||!t.developerAccepted||!t.funded||t.disputed)throw new Error('Accepted, funded and undisputed bounty required');
 if(t.policyHash!==hash(t.policy)||a.policyHash!==t.policyHash||a.fundingPolicyHash!==t.fundingPolicyHash||a.bindingHash!==binding(t))throw new Error('The funded agreement changed');
 if(a.kind!=='owner-acceptance'||a.prNumber!==t.prNumber||a.prNumber!==e.prNumber||a.headSha!==e.headSha||a.mergeSha!==e.mergeSha||!e.merged)throw new Error('Owner acceptance does not match this merged submission');
 if(!/^([a-f0-9]{40})$/i.test(e.headSha)||!/^([a-f0-9]{40})$/i.test(e.mergeSha||''))throw new Error('Valid GitHub commit evidence required');
 const merged=Date.parse(e.mergedAt||''),funded=Date.parse(t.fundedAt||''),accepted=Date.parse(a.acceptedAt);
 if(!Number.isFinite(merged)||!Number.isFinite(funded)||!Number.isFinite(accepted)||merged<funded||accepted<merged)throw new Error('The work must merge after funding and before owner acceptance');
 // Deliberately waive only CI checks. All identity, branch, merge and protected-file gates remain.
 const structural=evaluate({...t.policy,checks:[]},t.prNumber!,e);
 if(structural.status!=='eligible')throw new Error(structural.reasons.join(' '));
}
export function ownerAcceptance(t:Task,e:PrEvidence,ownerId:number,expected:{policyHash:unknown;headSha:unknown;mergeSha:unknown;prNumber:unknown},now=new Date().toISOString()):OwnerAcceptance{
 if(t.payment.state!=='NotRequested')throw new Error('Release has already started; it cannot be replaced');
 if(expected.policyHash!==t.policyHash||expected.headSha!==e.headSha||expected.mergeSha!==e.mergeSha||expected.prNumber!==t.prNumber)throw new Error('Submission changed; review it again');
 const a:OwnerAcceptance={kind:'owner-acceptance',ownerId,policyHash:t.policyHash,fundingPolicyHash:t.fundingPolicyHash||'',prNumber:t.prNumber!,headSha:e.headSha,mergeSha:e.mergeSha!,bindingHash:binding(t),acceptedAt:now};
 assertAcceptance(t,e,a);
 if(t.ownerAcceptance){assertAcceptance(t,e,t.ownerAcceptance);return t.ownerAcceptance;}
 return a;
}
export function evaluateRelease(t:Task,e:PrEvidence):Verdict{
 if(!t.ownerAcceptance)return evaluateMergePolicy(t,e);
 try{assertAcceptance(t,e,t.ownerAcceptance);return{status:'eligible',reasons:[],authorizationKind:'owner-acceptance',evidenceHash:hash({policyHash:t.policyHash,pr:t.prNumber,evidence:e,ownerAcceptance:t.ownerAcceptance})};}
 catch(error){return{status:'blocked',reasons:[(error as Error).message],evidenceHash:hash({policyHash:t.policyHash,pr:t.prNumber,evidence:e,ownerAcceptance:t.ownerAcceptance})};}
}
