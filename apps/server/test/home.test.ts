import test from 'node:test';
import assert from 'node:assert/strict';
import {homeSnapshot} from '../server/portal/home.ts';
import type {Bounty} from '../server/portal/store.ts';
import type {Task} from '../server/tasks/domain.ts';
function fixture(i:number,state='Processed',rail='base-usdc',developerId=i+100){
 const b={id:String(i),taskId:String(i),code:'NP-'+i,title:'Bounty '+i,repository:'owner/repo',private:true,owner:'owner',ownerId:1,published:true,branch:'main',createdAt:new Date(2026,0,i+1).toISOString(),amountCents:100,paymentRail:rail,token:'SECRET'} as unknown as Bounty;
 const t={id:String(i),funded:true,payment:{state},policy:{developerId,developerLogin:'worker'+developerId},recipient:{iban:'SECRET'},prNumber:developerId?9:null} as unknown as Task;
 return {b,t};
}
test('Home uses confirmed payments and separates currencies, drafts and unclaimed rewards',()=>{
 const fs=[fixture(1),fixture(2,'Submitted'),fixture(3,'Processed','monerium'),fixture(4,'NotRequested','base-usdc',0),fixture(5)];fs[4].b.published=false;
 const d=homeSnapshot(fs.map(f=>f.b),b=>fs.find(f=>f.b.id===b.id)!.t,101);
 assert.deepEqual(d.totals.paid,{eurCents:100,usdcCents:100});assert.deepEqual(d.totals.available,{eurCents:0,usdcCents:100});
 assert.equal(d.totals.bounties,4);assert.equal(d.totals.contributors,3);assert.equal(d.personal?.paid,1);assert.equal(d.personal?.created,0);
 assert.equal(d.leaders.length,2);assert.equal(JSON.stringify(d).includes('SECRET'),false);
 assert.equal(homeSnapshot(fs.map(f=>f.b),b=>fs.find(f=>f.b.id===b.id)!.t).personal,null);
});
test('Home bounds previews at five, rankings at ten, and clamps pages',()=>{
 const fs=Array.from({length:24},(_,i)=>fixture(i));const run=(page=1,filter='')=>homeSnapshot(fs.map(f=>f.b),b=>fs.find(f=>f.b.id===b.id)!.t,undefined,{},filter,page);
 const d=run();assert.equal(d.rows.length,5);assert.equal(d.rowCount,24);assert.equal(d.leaders.length,5);assert.equal(d.ranking.items.length,10);
 assert.equal(run(2).ranking.items[0].rank,11);assert.equal(run(99).ranking.items.length,4);assert.equal(run(99).ranking.page,3);
 assert.equal(run(1,'available').rows.length,0);assert.equal(run(1,'available').counts.paid,24);
 assert.throws(()=>run(1,'toString'));assert.throws(()=>run(-1));
});
test('Home does not count a duplicated task payout twice',()=>{
 const f=fixture(1);const d=homeSnapshot([f.b,{...f.b,id:'copy'}],()=>f.t);assert.equal(d.totals.paid.usdcCents,100);assert.equal(d.leaders[0].completed,1);
});
