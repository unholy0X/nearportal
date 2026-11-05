import test from 'node:test';
import assert from 'node:assert/strict';
import { euroCents, freshDraft, draftPayload, hydrateDraft, reconcileDraftIdentity } from '../bounty-model.mjs';

test('currency is exact integer cents and respects the sandbox limits', () => {
  for (const [text, cents] of [['0.01', 1], ['0.10', 10], ['1,25', 125], ['1000', 100000]]) assert.equal(euroCents(text), cents);
  for (const bad of ['', '0', '-1', '1.005', '1e2', '1000.01', 'Infinity']) assert.throws(() => euroCents(bad));
});
test('a complete draft serializes to the existing API without publishing or funding fields', () => {
  const draft = { ...freshDraft(), repository: 'example/project', checkName: 'escrow-receipts', branch: 'main', workflowPath: '.github/workflows/receipts.yml', protectedPaths: 'Cargo.toml\ntests/receipts.rs' };
  const body = draftPayload(draft);
  assert.equal(body.amountCents, 10000); assert.equal(body.checkAppId, 15368);
  assert(body.criteria.includes('Pending or failed deposits'));
  assert(!('funded' in body)); assert(!('published' in body));
  assert.equal(draftPayload({ ...draft, protectedPaths: '', checkAppId: '999' }).protectedPaths, draft.workflowPath);
  assert.equal(draftPayload({ ...draft, checkAppId: '999' }).checkAppId, 15368);
  assert(body.protectedPaths.includes(draft.workflowPath));
});
test('restored drafts cannot inject unsupported identity or unbounded criteria', () => {
  const restored = hydrateDraft({ template: 'unknown', id: 'fake', code: 'NP-FAKE', criteria: Array(50).fill({ title: 'criterion', detail: 'detail' }) });
  assert.equal(restored.template, 'near'); assert.equal(restored.id, null); assert.equal(restored.code, null); assert.equal(restored.criteria.length, 20);
});

test('USDC drafts pin an explicit refund address without requesting a wallet connection',()=>{
 const d={...freshDraft(),paymentRail:'base-usdc',refundAddress:'0x'+'c1ea2'.repeat(8),amount:'1',repository:'example/project',branch:'main',checkName:'acceptance',workflowPath:'.github/workflows/test.yml',protectedPaths:'test/acceptance.mjs'};
 const saved=hydrateDraft(d),body=draftPayload(saved);
 assert.equal(saved.paymentRail,'base-usdc');assert.equal(body.paymentRail,'base-usdc');assert.equal(body.amountCents,100);
 assert.equal(body.walletAddress,undefined);assert.equal(body.refundAddress,d.refundAddress);assert.equal(body.iban,undefined);
});

test('restoring a published or accepted bounty preserves inputs but clears its edit identity', () => {
  const draft = {...freshDraft(), id:'89459e8e-44d1-428c-8e90-e278f9e6338e', code:'NP-FC9F48C779', paymentRail:'base-usdc', amount:'1', title:'New USDC work'};
  const editable = {id:draft.id, ownerId:1, status:'Draft', taskId:null, published:false};
  assert.equal(reconcileDraftIdentity(draft, editable, 1).detached, false);
  for (const server of [{...editable,status:'Claimed',published:true}, {...editable,taskId:'accepted-task'}, {...editable,ownerId:2}]) {
    const result = reconcileDraftIdentity(draft, server, 1);
    assert.equal(result.detached,true); assert.equal(result.draft.id,null); assert.equal(result.draft.code,null);
    assert.equal(result.draft.title,draft.title); assert.equal(result.draft.paymentRail,'base-usdc'); assert.equal(result.draft.amount,'1');
    assert.equal(draft.id,editable.id);
  }
  assert.throws(()=>reconcileDraftIdentity(draft,null,1), /could not be verified/);
  assert.throws(()=>reconcileDraftIdentity(draft,{...editable,id:'other'},1), /could not be verified/);
});

test('hours and days preserve the exact agreed delivery window through serialization', async () => {
  const { deliveryHours, changeDeliveryUnit, deliveryLabel } = await import('../bounty-model.mjs');
  const complete = {...freshDraft(), repository:'example/project', branch:'main', workflowPath:'.github/workflows/check.yml', checkName:'acceptance', delivery:'fixed'};
  for (const rail of ['bank', 'base-usdc']) for (const hours of [1,6,12,24,48,168,2160]) {
    const draft = {...complete, paymentRail:rail, refundAddress:'0x'+'c1ea2'.repeat(8), deliveryValue:String(hours), deliveryUnit:'hours'};
    const days = changeDeliveryUnit(draft,'days');
    assert.equal(deliveryHours(hydrateDraft(days)),hours);
    assert.equal(draftPayload(days).marketTerms.deliveryHours,hours);
    assert.equal(changeDeliveryUnit(days,'hours').deliveryValue,String(hours));
  }
  assert.equal(deliveryLabel({...complete,deliveryValue:'48',deliveryUnit:'hours'}),'48 hours');
  assert.equal(deliveryLabel({...complete,deliveryValue:'7',deliveryUnit:'days'}),'7 days');
  assert.equal(draftPayload({...complete,delivery:'open'}).marketTerms,undefined);
});
test('legacy day drafts migrate and server hour terms remain authoritative', async () => {
  const { deliveryHours } = await import('../bounty-model.mjs');
  assert.equal(deliveryHours(hydrateDraft({delivery:'fixed',deliveryDays:'5'})),120);
  const server = hydrateDraft({deliveryDays:'5',marketTerms:{kind:'fixed',deliveryHours:6}});
  assert.equal(server.deliveryValue,'6'); assert.equal(server.deliveryUnit,'hours');
  assert.equal(deliveryHours(server),6);
});
test('invalid durations never silently become valid funding terms', async () => {
  const { deliveryHours } = await import('../bounty-model.mjs');
  const complete = {...freshDraft(),repository:'example/project',branch:'main',workflowPath:'.github/workflows/check.yml',checkName:'acceptance',delivery:'fixed'};
  for (const value of ['', '0','-1','0.5','2161','1e2','Infinity','abc']) {
    const draft={...complete,deliveryValue:value,deliveryUnit:'hours'};
    assert.throws(()=>deliveryHours(hydrateDraft(draft)));
    assert.throws(()=>draftPayload(draft));
  }
});

test('USDC drafts reject missing, zero or token refund destinations',()=>{
 const d={...freshDraft(),paymentRail:'base-usdc',repository:'example/project',branch:'main',checkName:'acceptance',workflowPath:'.github/workflows/test.yml'};
 for(const refundAddress of ['', '0x'+'0'.repeat(40),'0x036cbd53842c5426634e7929541ec2318f3dcf7e'])assert.throws(()=>draftPayload({...d,refundAddress}),/refund wallet/);
});

test('USDC drafts require a refund wallet the creator controls', async () => {
  const { validRefundAddress } = await import('../bounty-model.mjs');
  assert.equal(validRefundAddress('0x1111111111111111111111111111111111111111'), true);
  assert.equal(validRefundAddress(' 0x1111111111111111111111111111111111111111 '), true);
  for (const bad of ['', '0x123', '0x' + '0'.repeat(40), '0x036CbD53842c5426634e7929541eC2318f3dCF7e', 'not-a-wallet']) assert.equal(validRefundAddress(bad), false, bad);
});
