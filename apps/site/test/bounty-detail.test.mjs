import test from 'node:test';
import assert from 'node:assert/strict';
import { bountyStage, fundingState, protectedFiles, validBountyId } from '../bounty-detail-model.mjs';
test('a saved draft and preparing escrow never imply secured funds', () => {
  assert.equal(fundingState({status:'Draft'}), 'Not funded');
  assert.equal(fundingState({status:'Preparing'}), 'Preparing escrow');
  assert.equal(fundingState({task:{jobId:2,funded:false}}), 'Awaiting deposit');
  assert.equal(bountyStage({task:{jobId:2,funded:false}}), 0);
});
test('funding, review, release and processed receipt show distinct stages', () => {
  const b = {task:{funded:true,payment:{state:'NotRequested'}}};
  assert.equal(fundingState(b), 'Funds secured'); assert.equal(bountyStage(b),1);
  b.task.prNumber=6; assert.equal(bountyStage(b),2);
  b.task.payment.state='Requested'; assert.equal(bountyStage(b),3);
  b.task.payment.state='Processed'; assert.equal(bountyStage(b),4); assert.equal(fundingState(b),'Paid · payment confirmed');
});
test('workflow protection is displayed once and route identifiers are bounded', () => {
  assert.deepEqual(protectedFiles({workflowPath:'.github/workflows/ci.yml',protectedPaths:'.github/workflows/ci.yml\ntests/acceptance.rs'}), ['.github/workflows/ci.yml','tests/acceptance.rs']);
  assert(validBountyId('89459e8e-44d1-428c-8e90-e278f9e6338e')); assert(!validBountyId('../../settings')); assert(!validBountyId('------------------------------------'));
});

test('payout references link to the escrow contract and, when recorded, the exact transaction', async () => {
  const { explorerLinks } = await import('../bounty-detail-model.mjs');
  const ref = 'near:escrow.nearportal-pr-20261103-27419a.testnet:0';
  assert.deepEqual(explorerLinks(ref, 'Ep87YckjRdpUuve1QeKpEh6SbzSmEuKWfgeiDHxmWke3'), {
    network: 'testnet', payoutId: 0,
    contract: 'https://testnet.nearblocks.io/address/escrow.nearportal-pr-20261103-27419a.testnet',
    tx: 'https://testnet.nearblocks.io/txns/Ep87YckjRdpUuve1QeKpEh6SbzSmEuKWfgeiDHxmWke3',
  });
  assert.equal(explorerLinks(ref, null).tx, null);
  assert.equal(explorerLinks(ref, 'not a hash').tx, null);
  assert.equal(explorerLinks('near:escrow.app.near:3', null).contract, 'https://nearblocks.io/address/escrow.app.near');
  for (const bad of ['SIM-123', 'NP-5', 'near:javascript:alert(1):0', '']) assert.equal(explorerLinks(bad, null), null);
});

test('journey stops reflect real state: no "done" or "Released" before a processed payment', async () => {
  const { journeySteps } = await import('../bounty-detail-model.mjs');
  const draft = { status: 'Draft', task: null };
  assert.deepEqual(journeySteps(draft).map(s => s.state), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.equal(journeySteps(draft)[0].note, 'Draft · not funded');
  const blocked = { status: 'Blocked', task: { funded: true, prNumber: 2, policy: { developerId: 2, developerLogin: 'maya' }, verdict: { status: 'blocked' }, payment: { state: 'NotRequested' } } };
  const steps = journeySteps(blocked, { attention: true });
  assert.deepEqual(steps.map(s => s.state), ['done', 'done', 'current', 'todo', 'todo']);
  assert.equal(steps[2].alert, true); assert.equal(steps[2].note, 'PR #2 · blocked'); assert.equal(steps[1].note, '@maya');
  assert.equal(steps[3].note, 'After merge');
  const paid = { status: 'Paid', task: { ...blocked.task, verdict: { status: 'eligible' }, payment: { state: 'Processed' } } };
  assert.deepEqual(journeySteps(paid, { attention: true }).map(s => [s.state, s.alert]), [['done', false], ['done', false], ['done', false], ['done', false], ['done', false]]);
  assert.equal(journeySteps(paid)[4].note, 'Payment confirmed');
});

test('journey does not present the "Unclaimed" placeholder as a person', async () => {
  const { journeySteps } = await import('../bounty-detail-model.mjs');
  const steps = journeySteps({ status: 'AwaitingFunding', task: { funded: false, jobId: 3, policy: { developerId: 0, developerLogin: 'Unclaimed' }, payment: { state: 'NotRequested' } } });
  assert.equal(steps[1].note, 'After funding'); assert.equal(steps[0].note, 'Awaiting deposit');
});

test('crypto deposit proof links use confirmed receipts, group partials and reject unsafe values', async () => {
  const {cryptoDepositLinks}=await import('../bounty-detail-model.mjs');
  const txHash='0x'+'ab'.repeat(32),receipt={txHash,logIndex:0,blockNumber:'123',units:'400000'};
  const bounty={paymentRail:'base-usdc',task:{funded:true,crypto:{deposits:[receipt,{...receipt,logIndex:1,units:'600000'},receipt,{...receipt,txHash:'javascript:alert(1)'},{...receipt,units:'-1'}]}}};
  assert.deepEqual(cryptoDepositLinks(bounty),[{txHash,href:'https://sepolia.basescan.org/tx/'+txHash,units:'1000000'}]);
  assert.deepEqual(cryptoDepositLinks({...bounty,paymentRail:'bank'}),[]);
  assert.deepEqual(cryptoDepositLinks({...bounty,task:{...bounty.task,funded:false}}),[]);
});
