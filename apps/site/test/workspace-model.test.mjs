import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bountyStatus, columnFor, nextAction, scopeBounties, filterBounties, summary, pullRequestUrl, editorUrl } from '../workspace-model.mjs';
import { activeNav, NAV } from '../workspace-shell.mjs';

const base = { id: 'b1', ownerId: 1, title: 'NEAR receipts', repository: 'near/escrow', code: 'NP-1', status: 'Draft', amountCents: 10000, createdAt: '2026-11-04T00:00:00Z' };
const task = (over = {}) => ({ funded: false, jobId: null, prNumber: null, disputed: false, verdict: null, policy: {}, payment: { state: 'NotRequested' }, ...over });
const assigned = { developerId: 2, developerLogin: 'maya' };

test('nothing is shown as funded until the deposit is confirmed', () => {
  assert.equal(bountyStatus(base).key, 'toFund'); assert.equal(bountyStatus(base).detail, 'Draft');
  const pending = { ...base, status: 'Preparing', task: task({ jobId: 3 }) };
  assert.equal(bountyStatus(pending).key, 'toFund'); assert.equal(bountyStatus(pending).detail, 'Awaiting deposit');
  assert.equal(nextAction(pending).label, 'Continue funding');
  const funded = { ...pending, status: 'Open', task: task({ jobId: 3, funded: true }) };
  assert.equal(bountyStatus(funded).key, 'available'); assert.equal(bountyStatus(funded).detail, 'Funds secured');
});

test('a claimed bounty is never presented as available', () => {
  const b = { ...base, status: 'Claimed', task: task({ funded: true, policy: assigned }) };
  assert.equal(bountyStatus(b).key, 'inProgress'); assert.equal(bountyStatus(b).detail, '@maya');
  assert.equal(nextAction(b, 'client').label, 'Track work');
  assert.equal(nextAction(b, 'developer').label, 'Open editor'); assert.equal(nextAction(b, 'developer').external, true); assert.equal(new URL(nextAction(b, 'developer').href).hostname,'github.dev');
  // Assigned but never funded stays "To fund" — no "Funds secured" without a confirmed deposit.
  const unfunded = { ...b, task: task({ policy: assigned, jobId: 1 }) };
  assert.equal(bountyStatus(unfunded).key, 'toFund');
});

test('a merge or PR alone is not "Paid"; only a processed payment is', () => {
  const b = { ...base, task: task({ funded: true, prNumber: 42, policy: assigned }) };
  assert.equal(bountyStatus(b).key, 'inReview'); assert.equal(nextAction(b).href, 'https://github.com/near/escrow/pull/42');
  assert.equal(nextAction(b, 'developer').label, 'View checks');
  for (const state of ['Authorized', 'Signing', 'Signed', 'Submitted']) { b.task.payment.state = state; assert.equal(bountyStatus(b).key, 'paymentProcessing'); assert.equal(nextAction(b).label, 'Track payment'); }
  b.task.payment.state = 'NeedsAttention'; assert.equal(bountyStatus(b).key, 'attention');
  b.task.payment.state = 'Processed'; assert.equal(bountyStatus(b).key, 'paid'); assert.equal(nextAction(b).label, 'Receipt');
});

test('blocked verification and disputes need attention, in the right column per role', () => {
  const blocked = { ...base, task: task({ funded: true, prNumber: 7, policy: assigned, verdict: { status: 'blocked' } }) };
  assert.equal(bountyStatus(blocked).key, 'attention'); assert.equal(bountyStatus(blocked).detail, 'Verification blocked');
  assert.equal(columnFor(blocked, 'client'), 'review'); assert.equal(columnFor(blocked, 'developer'), 'review');
  const disputed = { ...blocked, task: { ...blocked.task, verdict: null, disputed: true } };
  assert.equal(bountyStatus(disputed).detail, 'Release paused'); assert.equal(columnFor(disputed, 'developer'), 'payment');
  assert.equal(nextAction(disputed).label, 'Review issue');
});

// Fixtures follow the market engine: marketTerms() output and Market["phase"] values
// (apps/server/server/portal/market.ts). An auction is funded before bidding starts.
const auctionTerms = { version: 1, kind: 'auction', budgetCents: 10000, deliveryHours: 72, biddingHours: 48, confirmationHours: 24 };
const fixedTerms = { version: 1, kind: 'fixed', budgetCents: 10000, deliveryHours: 72, biddingHours: 0, confirmationHours: 0 };
const auction = phase => ({ ...base, status: 'Open', marketTerms: auctionTerms, market: { phase }, task: task({ funded: true, jobId: 4 }) });
const sealed = { capabilities: { sealedBid: true, fixedDeadline: false } };
const live = { capabilities: { sealedBid: false, fixedDeadline: false } }; // current backend gates

test('a funded auction in the "offered" phase awaits confirmation, never "Available"', () => {
  assert.equal(bountyStatus(auction('offered'), sealed).key, 'awaitingConfirmation');
  assert.equal(bountyStatus(auction('offered'), sealed).label, 'Awaiting confirmation');
  assert.equal(bountyStatus(auction('bidding'), sealed).key, 'bidding');
  for (const phase of ['bidding', 'offered', undefined]) for (const options of [sealed, live, {}])
    assert.notEqual(bountyStatus(phase ? auction(phase) : { ...auction('x'), market: null }, options).key, 'available');
});

test('sealed-bid phases stay hidden while the capability gate is off', () => {
  for (const phase of ['bidding', 'offered']) {
    const s = bountyStatus(auction(phase), live);
    assert.equal(s.key, 'attention'); assert.equal(s.detail, 'Sealed-bid mode not enabled');
    assert.ok(!['bidding', 'awaitingConfirmation'].includes(bountyStatus(auction(phase), { capabilities: { fixedDeadline: true } }).key));
  }
  // Unfunded auctions are simply to fund; assigned ones follow the bound task.
  assert.equal(bountyStatus({ ...auction('unfunded'), status: 'Draft', task: null }, sealed).key, 'toFund');
  assert.equal(bountyStatus({ ...auction('in-progress'), task: task({ funded: true, policy: assigned }) }, sealed).key, 'inProgress');
  // Fixed-reward terms have no bidding phase; with the deadline gate closed they are flagged, never "Available".
  assert.equal(bountyStatus({ ...base, status: 'Open', marketTerms: fixedTerms, market: { phase: 'available' }, task: task({ funded: true }) }, { capabilities: { fixedDeadline: true } }).key, 'available');
  assert.equal(bountyStatus({ ...base, status: 'Open', marketTerms: fixedTerms, market: { phase: 'available' }, task: task({ funded: true }) }, sealed).detail, 'Deadline mode not enabled');
});

test('deadline bounties: processing, due date, submission and marker come from the server', () => {
  const on = { capabilities: { fixedDeadline: true } };
  const fixed = (assignment, extra = {}) => ({ ...base, status: 'Claimed', marketTerms: fixedTerms, market: { phase: assignment?.submission ? 'in-review' : 'in-progress', assignment }, task: task({ funded: true, policy: assigned, ...extra }) });
  const processing = bountyStatus(fixed({ marker: 'NP-0000000001-A2', confirmed: false, deadline: null, submission: null }), on);
  assert.equal(processing.label, 'Assignment processing');
  assert.equal(nextAction(fixed({ confirmed: false }), 'developer', on).label, 'View assignment');
  const due = Date.UTC(2026, 10, 12, 14, 0);
  const working = bountyStatus(fixed({ marker: 'NP-0000000001-A2', confirmed: true, deadline: due, submission: null }), on);
  assert.equal(working.key, 'inProgress'); assert.match(working.detail, /due /);
  assert.equal(nextAction(fixed({ confirmed: true, deadline: due }), 'developer', on).label, 'Submit work');
  const submitted = bountyStatus(fixed({ confirmed: true, deadline: due, submission: { prNumber: 4, headSha: 'a'.repeat(40) } }, { prNumber: 4 }), on);
  assert.equal(submitted.key, 'inReview'); assert.equal(submitted.label, 'Submitted');
  assert.equal(new URL(pullRequestUrl({ ...fixed({ marker: 'NP-0000000001-A2', confirmed: true }), repository: 'o/r' })).searchParams.get('body').split('\n')[0], 'NearPortal-Task: NP-0000000001-A2');
});

test('roles scope to owned or assigned bounties; filters search title, repo, code and contributor', () => {
  const own = { ...base, task: task({ policy: assigned }) }, other = { ...base, id: 'o', ownerId: 2 };
  assert.deepEqual(scopeBounties([own, other], { id: 1 }), [own]);
  assert.deepEqual(scopeBounties([own, other], { id: 2 }, 'developer'), [own]);
  assert.deepEqual(scopeBounties([own], null), []);
  assert.deepEqual(filterBounties([own], { query: 'MAYA receipts', repository: 'near/escrow' }), [own]);
  assert.equal(filterBounties([own], { query: 'missing' }).length, 0);
});

test('summary omits zeros and counts only processed payments as paid', () => {
  assert.deepEqual(summary([]), []);
  const review = { ...base, amountCents: 5000, task: task({ funded: true, prNumber: 1, policy: assigned }) };
  const merged = { ...base, id: 'm', amountCents: 2500, task: task({ funded: true, prNumber: 2, policy: assigned, payment: { state: 'Submitted' } }) };
  const paid = { ...base, id: 'p', amountCents: 10000, task: task({ funded: true, prNumber: 3, policy: assigned, payment: { state: 'Processed' } }) };
  assert.deepEqual(summary([review, merged, paid], 'developer'), ['1 in review', '1 payment processing', '€100 received']);
  assert.deepEqual(summary([review], 'client'), ['1 in review', '€50 secured in escrow']);
});

test('one navigation; detail pages belong to the list the viewer came from', () => {
  assert.deepEqual(NAV.map(n => n.label), ['Home', 'Find bounties', 'My contributions', 'My bounties']);
  assert.equal(activeNav('/bounties/x', { role: 'developer' }), '/app/work');
  assert.equal(activeNav('/bounties/x', { role: 'client' }), '/app/bounties');
  assert.equal(activeNav('/bounties/x', {}), '/bounties');
  assert.equal(activeNav('/app/new'), '/app/bounties');
});

test('board page controls have unique IDs', () => {
  const html = readFileSync(new URL('../board.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(ids.length, new Set(ids).size);
});

test('USDC amounts are never counted as euros in the shared summary',()=>{
 const b={...base,paymentRail:'base-usdc',amountCents:100,task:task({funded:true,policy:assigned,payment:{state:'Processed'}})};
 assert.deepEqual(summary([b],'developer'),['1.00 USDC received']);
});

test('the "Unclaimed" placeholder on open bounties is never shown as a contributor', () => {
  const open = { ...base, status: 'Open', task: task({ funded: true, jobId: 1, policy: { developerId: 0, developerLogin: 'Unclaimed' } }) };
  assert.equal(bountyStatus(open).key, 'available'); assert.doesNotMatch(bountyStatus(open).detail, /Unclaimed/);
  const unfunded = { ...open, status: 'AwaitingFunding', task: { ...open.task, funded: false } };
  assert.equal(bountyStatus(unfunded).detail, 'Awaiting deposit');
});

test('Submit PR targets the repository and agreed base with the exact bounty marker prefilled',()=>{
 const b={...base,branch:'release/next',code:'NP-4633CDF7A2',title:'Escrow & receipts'};
 const url=new URL(pullRequestUrl(b));
 assert.equal(url.origin,'https://github.com');assert.equal(url.pathname,'/near/escrow/compare/release%2Fnext');
 assert.equal(url.searchParams.get('title'),b.title);assert.equal(url.searchParams.get('body').split('\n')[0],'NearPortal-Task: NP-4633CDF7A2');
 assert.equal(url.searchParams.get('quick_pull'),'1');
 assert.equal(pullRequestUrl({...b,preparedPrUrl:'https://evil.example/near/escrow/compare/main'}),url.href);
 const prepared='https://github.com/near/escrow/compare/main...prepared?expand=1';assert.equal(pullRequestUrl({...b,preparedPrUrl:prepared}),prepared);
});

test('work starts in the browser editor on the agreed branch, separate from PR submission',()=>{
 assert.equal(editorUrl({...base,branch:'release/next'}),'https://github.dev/near/escrow/tree/release%2Fnext');
 assert.equal(editorUrl({...base,repository:'https://evil.example'}),'/bounties/b1');
});

test('merged PR remains visible as verification pending until a processed payment',()=>{
 const b={...base,task:task({funded:true,policy:assigned,prNumber:9,evidence:{merged:true},verdict:{status:'pending',reasons:['Waiting for acceptance on the submitted commit.']}})};
 assert.equal(bountyStatus(b).label,'Merged · verification pending');assert.equal(columnFor(b,'developer'),'review');
 assert.equal(bountyStatus({...b,task:{...b.task,payment:{state:'Processed'}}}).key,'paid');
});

test('a confirmed dispute refund is never a developer payment or an available bounty',()=>{
 const b={...base,task:task({funded:true,disputed:true,payment:{state:'NotRequested'},refund:{state:'Processed'}})};
 const status=bountyStatus(b);assert.equal(status.key,'refunded');assert.equal(status.label,'Refunded');
});
