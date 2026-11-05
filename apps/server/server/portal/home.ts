import { bountyStatus, STATUSES, type StatusKey, type Capabilities } from '../../src/workspace/workspace-model.mjs';
import type { Bounty } from './store.ts';
import type { Task } from '../tasks/domain.ts';
type Totals={eurCents:number;usdcCents:number};
const zero=():Totals=>({eurCents:0,usdcCents:0});
function add(total:Totals,b:Bounty){total[b.paymentRail==='base-usdc'?'usdcCents':'eurCents']+=b.amountCents;}
export function homeSnapshot(bounties:Bounty[],taskFor:(b:Bounty)=>Task|null,userId?:number,capabilities:Capabilities={},filter='',page=1){
 if(filter && !Object.hasOwn(STATUSES,filter))throw new Error('Unknown bounty status');
 if(!Number.isSafeInteger(page)||page<1)throw new Error('Invalid ranking page');
 const all=bounties.map(b=>({b,t:taskFor(b)}));
 const published=all.filter(({b})=>b.published);
 const paid=zero(),available=zero(),counts=Object.fromEntries(Object.keys(STATUSES).map(k=>[k,0])) as Record<StatusKey,number>;
 const owners=new Set<number>(),contributors=new Set<number>(),paidTasks=new Set<string>();
 const ranking=new Map<number,{id:number;login:string;completed:number;earned:Totals}>();
 for(const {b,t} of published){
  const status=bountyStatus({...b,task:t},{capabilities});counts[status.key]++;owners.add(b.ownerId);
  if(t?.policy.developerId)contributors.add(t.policy.developerId);
  if(status.key==='available')add(available,b);
  if(status.key==='paid'&&t&&!paidTasks.has(t.id)){
   paidTasks.add(t.id);add(paid,b);
   if(t.policy.developerId){let worker=ranking.get(t.policy.developerId);if(!worker){worker={id:t.policy.developerId,login:t.policy.developerLogin,completed:0,earned:zero()};ranking.set(worker.id,worker);}worker.completed++;add(worker.earned,b);}
  }
 }
 const ranked=[...ranking.values()].sort((a,b)=>b.completed-a.completed||a.login.localeCompare(b.login)||a.id-b.id).map((worker,index)=>({...worker,rank:index+1}));
 const personal=userId?all.filter(({b,t})=>b.ownerId===userId||t?.policy.developerId===userId):[];
 const personalCounts={created:0,assigned:0,review:0,processing:0,paid:0,attention:0,earned:zero()};
 const earnedTasks=new Set<string>();
 for(const {b,t} of personal){
  if(b.ownerId===userId)personalCounts.created++;
  if(t?.policy.developerId!==userId)continue;
  const status=bountyStatus({...b,task:t},{capabilities});
  if(status.key==='inProgress')personalCounts.assigned++;
  if(status.key==='inReview')personalCounts.review++;
  if(status.key==='paymentProcessing')personalCounts.processing++;
  if(status.key==='attention')personalCounts.attention++;
  if(status.key==='paid'&&!earnedTasks.has(t!.id)){personalCounts.paid++;add(personalCounts.earned,b);earnedTasks.add(t!.id);}
 }
 const visible=published.filter(({b,t})=>filter?bountyStatus({...b,task:t},{capabilities}).key===filter:Boolean(t?.funded)).sort((a,b)=>Date.parse(b.b.createdAt)-Date.parse(a.b.createdAt)||a.b.id.localeCompare(b.b.id));
 const rows=visible.slice(0,5).map(({b,t})=>({id:b.id,code:b.code,title:b.title,repository:b.repository,private:b.private,owner:b.owner,ownerId:b.ownerId,branch:b.branch,prNumber:t?.prNumber??null,amountCents:b.amountCents,paymentRail:b.paymentRail,status:bountyStatus({...b,task:t},{capabilities}),assignedToYou:Boolean(userId&&t?.policy.developerId===userId)}));
 const pages=Math.max(1,Math.ceil(ranked.length/10));const currentPage=Math.min(page,pages);
 return {scope:'Published bounties',updatedAt:new Date().toISOString(),totals:{paid,available,bounties:published.length,funded:published.filter(({t})=>t?.funded).length,creators:owners.size,contributors:contributors.size},counts,rows,rowCount:visible.length,filter,personal:userId?personalCounts:null,leaders:ranked.slice(0,5),ranking:{items:ranked.slice((currentPage-1)*10,currentPage*10),page:currentPage,pages,total:ranked.length,pageSize:10}};
}
