import test from 'node:test';
import assert from 'node:assert/strict';
import {deadlineState,duration} from '../deadline.mjs';
const end=1800000000000;
const bounty={marketTerms:{kind:'fixed'},market:{deliveryHours:1,assignment:{confirmed:true,deadline:end}}};
test('countdown has exact hours, minutes, seconds and bounded remaining fraction',()=>{const s=deadlineState(bounty,end-3599000);assert.equal(s.value,'00:59:59');assert.ok(s.progress<1&&s.progress>.99);assert.equal(deadlineState(bounty,end-600000).kind,'urgent');assert.equal(deadlineState(bounty,end-99999999).progress,1);});
test('end of clock never claims the bounty reopened or paid',()=>{const s=deadlineState(bounty,end);assert.equal(s.kind,'expired');assert.equal(s.value,'00:00:00');assert.equal(s.note,'Awaiting assignment update');});
test('a timely submission stops the countdown even after the deadline',()=>{const b=structuredClone(bounty);b.market.assignment.submission={receivedAt:end-1};assert.equal(deadlineState(b,end+99999).kind,'submitted');b.market.settlement={processed:true};assert.equal(deadlineState(b,end),null);});
test('unclaimed and unconfirmed assignments never start a clock',()=>{assert.equal(deadlineState({marketTerms:{kind:'fixed'},market:{deliveryHours:1}},end).value,'1 hour');assert.equal(deadlineState({marketTerms:{kind:'fixed'},market:{assignment:{confirmed:false}}},end).kind,'pending');assert.equal(deadlineState({},end),null);assert.equal(duration(48),'2 days');});
test('Home read projection and terminal payment states use the same model',()=>{assert.equal(deadlineState({deadlineWindow:bounty.market},end-1000).value,'00:00:01');assert.equal(deadlineState({...bounty,status:{key:'paid'}},end),null);assert.equal(deadlineState({...bounty,task:{payment:{state:'Processed'}}},end),null);});

test('an unsubmitted PR with the assignment marker is named without stopping the clock', async () => {
  const { deadlineState } = await import('../deadline.mjs');
  const { unsubmittedPr, journeySteps } = await import('../bounty-detail-model.mjs');
  const now = Date.UTC(2026, 10, 5, 16, 20), assignment = { confirmed: true, deadline: now + 40 * 60000, submission: null, candidate: { prNumber: 5, merged: true } };
  const b = { marketTerms: { kind: 'fixed' }, market: { deliveryHours: 1, assignment }, task: { funded: true, prNumber: null, payment: { state: 'NotRequested' }, policy: { developerId: 7, developerLogin: 'dev' } }, status: 'Claimed' };
  const s = deadlineState(b, now);
  assert.equal(s.kind, 'active'); assert.equal(s.value, '00:40:00'); assert.equal(s.note, 'PR #5 found · not submitted yet');
  assert.equal(unsubmittedPr(b), 5);
  assert.equal(journeySteps(b)[2].note, 'PR #5 found · not submitted');
  assert.equal(unsubmittedPr({ ...b, market: { ...b.market, assignment: { ...assignment, submission: { prNumber: 5 } } } }), null, 'submitted');
  assert.equal(deadlineState({ ...b, market: { ...b.market, assignment: { ...assignment, candidate: undefined } } }, now).note, 'Exclusive delivery window');
});
