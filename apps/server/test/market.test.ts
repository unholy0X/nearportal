import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { marketTerms, newMarket, transition as go, marketView, MARKET_RELAY_GRACE_MS, type Market, type Command } from "../server/portal/market.ts";
import { MarketStore } from "../server/portal/market-store.ts";
import { PortalStore } from "../server/portal/store.ts";
const H=3_600_000, NOW=1_800_000_000_000, POLICY="a".repeat(64), SHA="b".repeat(40);
const alice={userId:2,login:"alice",repositoryAccess:true,payoutVersion:"payout-alice"};
const bob={...alice,userId:3,login:"bob",payoutVersion:"payout-bob"};
function fresh(kind:"fixed"|"auction"="fixed") { return newMarket("NP-0123456789",1,POLICY,marketTerms({kind,deliveryHours:24,biddingHours:2,confirmationHours:1},10000)); }
function funded(kind:"fixed"|"auction"="fixed") { return go(fresh(kind),{type:"fund",confirmedCents:10000},NOW); }
// The delivery clock starts only once the chain confirms the assignment.
const confirm=(m:Market,at=m.assignment!.acceptedAt)=>go(m,{type:"confirm-assignment",generation:m.assignment!.generation,acceptedAt:at,deadline:at+m.terms.deliveryHours*H},at);
function claimed() { return confirm(go(funded(),{type:"claim",person:alice,acceptedPolicyHash:POLICY},NOW)); }
const submit:Command={type:"submit",userId:2,generation:1,marker:"NP-0123456789-A1",prNumber:42,headSha:SHA};
function bid(m:Market, person=alice, price=5000, at=NOW) { return go(m,{type:"bid",person,amountCents:price,acceptedPolicyHash:POLICY,bidId:`bid-user-${person.userId}`},at); }
const checked=[alice,bob].map(p=>({userId:p.userId,payoutVersion:p.payoutVersion,eligible:true}));
const select:Command={type:"select",checkedBidders:checked};
test("validates immutable mode terms, time limits and integer cents",()=>{
 for(const patch of [{kind:"other"},{deliveryHours:0},{deliveryHours:"24"},{deliveryHours:1.5},{deliveryHours:2161},{version:2},{biddingHours:0},{confirmationHours:73}]) assert.throws(()=>marketTerms({kind:"auction",deliveryHours:24,biddingHours:2,...patch},10000));
 assert.throws(()=>marketTerms({kind:"fixed",deliveryHours:24},100.5));
});
test("fund before claims; exact budget recorded separately from surplus",()=>{
 assert.throws(()=>go(fresh(),{type:"claim",person:alice,acceptedPolicyHash:POLICY},NOW));
 assert.throws(()=>bid(fresh("auction")));
 assert.throws(()=>go(fresh(),{type:"fund",confirmedCents:10001},NOW));
});
test("exclusive claim, eligibility and acceptance of exact funded terms",()=>{
 const m=claimed(); assert.equal(m.assignment!.deadline,NOW+24*H);
 assert.throws(()=>go(m,{type:"claim",person:bob,acceptedPolicyHash:POLICY},NOW));
 for(const person of [{...alice,userId:1},{...alice,repositoryAccess:false},{...alice,payoutVersion:""}]) assert.throws(()=>go(funded(),{type:"claim",person,acceptedPolicyHash:POLICY},NOW));
 assert.throws(()=>go(funded(),{type:"claim",person:alice,acceptedPolicyHash:"wrong"},NOW));
});
test("deadline boundary: submit at deadline, expire strictly afterwards",()=>{
 const m=claimed(),due=m.assignment!.deadline;
 assert.throws(()=>go(m,{type:"expire"},due)); assert.equal(go(m,submit,due).phase,"in-review");
 assert.throws(()=>go(m,submit,due+1)); assert.throws(()=>go(m,{type:"expire"},due+MARKET_RELAY_GRACE_MS)); assert.equal(go(m,{type:"expire"},due+MARKET_RELAY_GRACE_MS+1).phase,"available");
});
test("timely commit survives late review and cannot expire or withdraw",()=>{
 const m=go(claimed(),submit,NOW+H);
 assert.throws(()=>go(m,{type:"expire"},NOW+100*H));
 assert.throws(()=>go(m,{type:"withdraw",userId:2,generation:1},NOW+H));
 const paid=go(m,{type:"authorize-payment",generation:1,headSha:SHA,verified:true,settlementId:"settlement-123"},NOW+100*H);
 assert.equal(paid.phase,"payment-processing"); assert.equal(paid.settlement!.developerCents,10000);
});
test("same PR may update its commit before deadline, never after",()=>{
 let m=go(claimed(),submit,NOW+H); m=go(m,{...submit,headSha:"c".repeat(40)},NOW+2*H);
 assert.equal(m.assignment!.submission!.headSha,"c".repeat(40));
 assert.throws(()=>go(m,{...submit,prNumber:43},NOW+3*H)); assert.throws(()=>go(m,submit,NOW+25*H));
 assert.throws(()=>go(m,{type:"authorize-payment",generation:1,headSha:SHA,verified:true,settlementId:"settlement-123"},NOW+25*H));
});
test("expiry gives next developer a fresh window and rejects old assignment PR",()=>{
 let m=go(claimed(),{type:"expire"},NOW+25*H);
 m=confirm(go(m,{type:"claim",person:bob,acceptedPolicyHash:POLICY},NOW+26*H));
 assert.equal(m.assignment!.deadline,NOW+50*H); assert.equal(m.assignment!.marker,"NP-0123456789-A2");
 assert.throws(()=>go(m,submit,NOW+27*H)); assert.equal(m.terms.budgetCents,10000);
});
test("only the developer can withdraw an unsubmitted claim",()=>{
 assert.throws(()=>go(claimed(),{type:"withdraw",userId:3,generation:1},NOW+H));
 assert.throws(()=>go(claimed(),{type:"withdraw",userId:2,generation:1},NOW+H),"the chain is cleared before reopening");
 const requested=go(claimed(),{type:"request-withdraw",userId:2,generation:1},NOW+H);
 assert.throws(()=>go(requested,submit,NOW+H),/being released/);
 const m=go(requested,{type:"withdraw",userId:2,generation:1},NOW+H); assert.equal(m.phase,"available"); assert.equal(m.fundedAt,NOW);
});
test("sealed bids expose own bid or owner bids only and hide payout versions",()=>{
 const m=bid(bid(funded("auction")),bob,4000,NOW+1);
 assert.equal(marketView(m).bids.length,0); assert.equal(marketView(m,2).bids.length,1); assert.equal(marketView(m,1).bids.length,2);
 assert.ok(!JSON.stringify(marketView(m,1)).includes("payout-alice"));
 assert.throws(()=>bid(m,alice,10001)); assert.throws(()=>bid(m,alice,1,NOW+2*H));
});
test("lowest eligible wins; failed/incomplete eligibility reads cannot skip cheaper bids",()=>{
 const m=bid(bid(funded("auction"),alice,5000),bob,4000,NOW+1);
 assert.throws(()=>go(m,{type:"select",checkedBidders:checked.slice(0,1)},NOW+2*H));
 assert.equal(go(m,select,NOW+2*H).offer!.bidId,"bid-user-3");
 assert.equal(go(m,{type:"select",checkedBidders:checked.map(c=>c.userId===3?{...c,eligible:false}:c)},NOW+2*H).offer!.bidId,"bid-user-2");
});
test("ties use final offer receipt time; editing resets priority",()=>{
 let m=bid(bid(funded("auction"),alice,5000),bob,5000,NOW+1);
 assert.equal(go(m,select,NOW+2*H).offer!.bidId,"bid-user-2");
 m=bid(m,alice,5000,NOW+2); assert.equal(go(m,select,NOW+2*H).offer!.bidId,"bid-user-3");
});
test("winner confirms; timeout offers next candidate without starting delivery clock",()=>{
 let m=go(bid(bid(funded("auction"),alice,4000),bob,5000),select,NOW+2*H);
 assert.equal(m.assignment,null); assert.throws(()=>go(m,select,NOW+3*H-1));
 m=go(m,select,NOW+3*H); assert.equal(m.offer!.bidId,"bid-user-3");
 m=confirm(go(m,{type:"accept-offer",person:bob,acceptedPolicyHash:POLICY},NOW+3*H+1));
 assert.equal(m.assignment!.deadline,NOW+27*H+1); assert.equal(m.assignment!.rewardCents,5000);
});
test("rejects wrong winner, expired offer and changed payout destination",()=>{
 const m=go(bid(funded("auction")),select,NOW+2*H);
 for(const [person,at] of [[bob,NOW+2*H],[{...alice,payoutVersion:"changed"},NOW+2*H],[alice,NOW+3*H]] as const) assert.throws(()=>go(m,{type:"accept-offer",person,acceptedPolicyHash:POLICY},at));
});
test("failed auction assignment retains full budget and starts fresh bidding",()=>{
 let m=go(bid(funded("auction")),select,NOW+2*H); m=confirm(go(m,{type:"accept-offer",person:alice,acceptedPolicyHash:POLICY},NOW+2*H));
 m=go(m,{type:"expire"},NOW+27*H); assert.equal(m.phase,"bidding"); assert.equal(m.round,2); assert.equal(m.bids.length,0); assert.equal(m.terms.budgetCents,10000); assert.equal(m.settlement,null);
});
test("settlement conserves budget, independently confirms reward/refund, prevents double release",()=>{
 let m=go(bid(funded("auction")),select,NOW+2*H); m=confirm(go(m,{type:"accept-offer",person:alice,acceptedPolicyHash:POLICY},NOW+2*H)); m=go(m,submit,NOW+3*H);
 m=go(m,{type:"authorize-payment",generation:1,headSha:SHA,verified:true,settlementId:"settlement-123"},NOW+4*H);
 assert.equal(m.settlement!.developerCents+m.settlement!.refundCents,10000);
 m=go(m,{type:"payment-confirmed",settlementId:"settlement-123",leg:"developer"},NOW+5*H); assert.equal(m.phase,"payment-processing");
 assert.throws(()=>go(m,{type:"payment-confirmed",settlementId:"wrong-123",leg:"refund"},NOW+5*H));
 m=go(m,{type:"payment-confirmed",settlementId:"settlement-123",leg:"refund"},NOW+6*H); assert.equal(m.phase,"paid");
 assert.throws(()=>go(m,{type:"authorize-payment",generation:1,headSha:SHA,verified:true,settlementId:"settlement-124"},NOW+6*H));
});
test("dispute pauses expiry and payment; rejected commands never mutate input",()=>{
 const before=claimed(),copy=structuredClone(before); assert.throws(()=>go(before,{type:"expire"},NOW)); assert.deepEqual(before,copy);
 const paused=go(go(before,submit,NOW),{type:"pause"},NOW);
 assert.throws(()=>go(paused,{type:"expire"},NOW+30*H));
 assert.throws(()=>go(paused,{type:"authorize-payment",generation:1,headSha:SHA,verified:true,settlementId:"settlement-123"},NOW));
});
test("durable CAS rejects racing claims; audit and encrypted outbox commit atomically",()=>{
 const db=new DatabaseSync(":memory:"), crypto=new PortalStore(db,"/unused",Buffer.alloc(32,7)), store=new MarketStore(db,crypto);
 store.create("bounty",fresh()); store.apply("bounty",0,{type:"fund",confirmedCents:10000},NOW);
 store.apply("bounty",1,{type:"claim",person:alice,acceptedPolicyHash:POLICY},NOW);
 assert.throws(()=>store.apply("bounty",1,{type:"claim",person:bob,acceptedPolicyHash:POLICY},NOW));
 assert.equal(store.get("bounty").assignment!.userId,2);
 assert.equal((db.prepare("SELECT count(*) AS n FROM portal_market_events").get() as any).n,2);
 assert.equal((db.prepare("SELECT count(*) AS n FROM portal_market_outbox").get() as any).n,1);
 assert.ok(!(db.prepare("SELECT body FROM portal_markets").get() as any).body.includes("alice")); db.close();
});

test("chain confirmation starts a full delivery window and rejects forged clocks",()=>{
 const m=go(funded(),{type:"claim",person:alice,acceptedPolicyHash:POLICY},NOW);
 assert.throws(()=>go(m,submit,NOW+H),/still being confirmed/,"no work is accepted while processing");
 assert.throws(()=>go(m,{type:"expire"},NOW+100*H),/unconfirmed/,"an unconfirmed assignment never expires");
 const confirmed=go(m,{type:"confirm-assignment",generation:1,acceptedAt:NOW+H,deadline:NOW+25*H},NOW+H);
 assert.equal(confirmed.assignment!.deadline,NOW+25*H);
 assert.throws(()=>go(m,{type:"confirm-assignment",generation:1,acceptedAt:NOW+H,deadline:NOW+26*H},NOW+H));
});

test("all-ineligible auctions can explicitly reopen without refunding the budget",()=>{
 let m=go(bid(funded("auction")),{type:"select",checkedBidders:[{userId:2,eligible:false,payoutVersion:alice.payoutVersion}]},NOW+2*H);
 assert.equal(m.offer,null); assert.equal(m.bids[0]!.status,"ineligible");
 m=go(m,{type:"reopen-bidding",ownerId:1},NOW+3*H);
 assert.equal(m.round,2); assert.equal(m.biddingClosesAt,NOW+5*H); assert.equal(m.terms.budgetCents,10000);
});
test("outbox write failure rolls state and audit back together",()=>{
 const db=new DatabaseSync(":memory:"),crypto=new PortalStore(db,"/unused",Buffer.alloc(32,7)),store=new MarketStore(db,crypto);
 store.create("bounty",fresh()); store.apply("bounty",0,{type:"fund",confirmedCents:10000},NOW);
 db.exec("CREATE TRIGGER fail_market_outbox BEFORE INSERT ON portal_market_outbox BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;");
 assert.throws(()=>store.apply("bounty",1,{type:"claim",person:alice,acceptedPolicyHash:POLICY},NOW),/simulated disk failure/);
 assert.equal(store.get("bounty").phase,"available"); assert.equal(store.get("bounty").revision,1);
 assert.equal((db.prepare("SELECT count(*) AS n FROM portal_market_events").get() as any).n,1); db.close();
});
