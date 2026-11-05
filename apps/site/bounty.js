import { deadlineIndicator, duration } from '/deadline.mjs';
import { renderJourney } from '/journey.mjs';
import { fundingProgress } from '/funding-progress.mjs';
import { mountShell, icon as uiIcon, poll } from '/workspace-shell.mjs';
import { bountyStatus, pullRequestUrl, editorUrl } from '/workspace-model.mjs';
import { portalWait, portalCelebrate, CELEBRATION_MS } from '/portal-wait.mjs';
import { bountyStage, fundingState, protectedFiles, validBountyId, explorerLinks, cryptoDepositLinks, bountyMilestones, suggestedBranch, parsePullRequest } from '/bounty-detail-model.mjs';
const $ = selector => document.querySelector(selector);
const id = decodeURIComponent(location.pathname.split('/').filter(Boolean).at(-1));
const state = { refreshRequestedAt: '', walletAddress: '', bounty: null, me: null, busy: false, consent: '', claimConsent: '', deposit: null, depositError: '', error: '', last: '', checkMismatch: false, checkNames: [], checkedRevision: '', pr: '', offline: false, treasury: null, treasuryLoading: false, treasuryAt: 0, treasuryConsent: '', manualBank: false, treasurySubmission: false, treasuryReadError: false, treasuryEpoch: 0 };
const money = amount => state.bounty?.paymentRail === 'base-usdc' ? new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(amount/100)+' USDC' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: amount % 100 ? 2 : 0 }).format(amount / 100);
const date = value => { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function icon(name) { return uiIcon(name); }
const shell = mountShell($('#app-header'), { path: location.pathname, brandSrc: '/public/brand/guide.png' });
for (const node of document.querySelectorAll('[data-icon]')) node.prepend(icon(node.dataset.icon));
$('#repo-line').prepend(icon('github'));
function link(text, href, className = '') { const node = el('a', className, text); node.href = href; if (href.startsWith('https://')) { node.target = '_blank'; node.rel = 'noopener noreferrer'; } return node; }
function button(text, action, className = 'ui-button', disabled = false) { const node = el('button', className, text); node.type = 'button'; node.disabled = disabled || state.busy; node.addEventListener('click', action); return node; }
function pill(text, secured = false) { return el('span', 'pill ' + (secured ? 'pill-secured' : 'pill-warm'), text); }
function fact(parent, title, value) { const item = el('div'); item.append(el('dt', '', title), el('dd', '', value ?? 'Not available yet')); parent.append(item); }
async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; } } catch { /* Embedded browsers may not expose Clipboard API permissions. */ }
  const focused = document.activeElement;
  const field = document.createElement('textarea'); field.value = text; field.readOnly = true;
  field.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
  document.body.append(field); field.focus(); field.select(); field.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand('copy'); }
  finally { field.remove(); focused?.focus({ preventScroll: true }); }
  if (!copied) throw new Error('Clipboard unavailable');
}
function copyRow(text, label = 'Copy') { const row = el('div', 'copy-row'); row.append(el('code', '', text), button(label, async () => { try { await copyText(text); toast(label === 'Copy address' ? 'Wallet address copied' : 'Copied to clipboard'); } catch { toast('Copy unavailable. Select and copy the text.'); } }, '', false)); return row; }
function toast(text) { $('#toast').textContent = text; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 4000); }
async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = state.me?.csrf || ''; }
  const response = await fetch('/api/portal' + path, { method: body === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json(); if (!response.ok) { const error = new Error(data.error || 'Unable to complete this request.'); error.status = response.status; throw error; } return data;
}
/** Publishes a bank draft; on refusal, re-reads /me so the prerequisite steps reflect the server's view. */
async function publishBankBounty() {
  if (await action('publish', { revision: state.bounty.revision })) return;
  try { const me = await api('/me'); if (me.user?.id === state.me?.user?.id) { state.me = me; render(); } } catch { /* Keep the visible error; the next focus retries. */ }
}
/** Celebrate once when funding is confirmed while this page is open. */
function celebrationMark(b) {
  if (!(state.celebrateAt && Date.now() - state.celebrateAt < CELEBRATION_MS && b.task?.funded)) return null;
  return portalCelebrate({ startedAt: state.celebrateAt, title: 'Funds secured!', detail: b.paymentRail === 'base-usdc' ? 'Your USDC is confirmed and recorded in the NEAR escrow. Contributors can claim it now.' : 'Your deposit is confirmed in escrow. Contributors can claim it now.' });
}
/** True while the creator is waiting on escrow setup or a deposit; drives the animation and faster refresh. */
function awaitingFunding(b = state.bounty) { return Boolean(b && b.role === 'client' && b.status !== 'Draft' && !b.error && !b.task?.funded && !b.task?.disputed && !b.task?.refund); }
async function action(name, body = {}) {
  if (state.busy) return;
  state.busy = true; state.busyAction = name; state.error = ''; render();
  try { const result = await api(`/bounties/${state.bounty.id}/${name}`, body); state.bounty = result.bounty; state.consent = ''; state.claimConsent = ''; state.last = ''; if(name==='refresh'){state.refreshRequestedAt=new Date().toISOString();toast('Verification refresh requested. Results update automatically.');} return true; }
  catch (error) { state.error = error.message; return false; }
  finally { state.busy = false; state.busyAction = ''; render(); }
}
function consent(container, text, checked, onChange) {
  const label = el('label', 'reward-consent'), input = el('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = state.busy;
  input.addEventListener('change', () => { onChange(input.checked); renderReward(); $('#reward-content input[type=checkbox]')?.focus({ preventScroll: true }); }); label.append(input, el('span', '', text)); container.append(label);
}
function renderIdentity() {
  const user = state.me?.user;
  shell.setMe(state.me);
  $('#identity-label').textContent = (user?.local ? 'Local GitHub preview' : user ? 'GitHub connected' : 'Not signed in') + (state.me?.mode === 'simulation' ? ' · Simulation' : state.bounty?.paymentRail === 'base-usdc' ? ' · Base Sepolia testnet' : ' · NEAR testnet · Monerium sandbox');
}
function render() {
  const b = state.bounty;
  renderIdentity();
  const error = state.error || state.depositError || b?.error || ''; $('#detail-error').hidden = !error; $('#detail-error').textContent = error;
  if (!b) return;
  $('#loading').hidden = true; $('#bounty-content').hidden = false;
  document.title = `${b.title} — NearPortal`;
  $('#bounty-title').textContent = b.title; $('#repository-name').textContent = b.repository; $('#bounty-code').textContent = b.code;
  const status = bountyStatus(b, { capabilities: state.me?.bountyModeCapabilities }), chip = el('span', 'ui-status ui-status-' + status.tone);
  chip.append(document.createTextNode(status.label === 'Available' ? 'Not claimed' : status.label));
  const badges = $('#hero-badges'); badges.replaceChildren(chip);
  const accessTag = $('#access-tag'); accessTag.replaceChildren(); if (b.private) { accessTag.className = 'ui-tag'; accessTag.append(icon('lock'), document.createTextNode('Private')); }
  const fromList = b.role === 'developer' ? ['/app/work', 'Contributions'] : b.role === 'client' ? ['/app/bounties', 'My bounties'] : ['/bounties', 'Explore'];
  $('#back-link').href = fromList[0]; $('#back-link').lastChild.textContent = 'Back to ' + fromList[1]; shell.setActive(location.pathname, b.role);
  $('#created-by').textContent = `Created by @${b.owner}${b.createdAt ? ' · ' + date(b.createdAt) : ''}`;
  $('#edit-draft').hidden = b.role !== 'client' || b.status !== 'Draft'; $('#edit-draft').href = '/app/new?draft=' + b.id;
  const clock=deadlineIndicator(b); $('#delivery-window').replaceChildren(...(clock?[clock]:[]));
  renderMilestones(b); renderIssue(b, status);
  $('#brief-description').textContent = b.description || 'No description provided.';
  const criteria = $('#criteria-list'); criteria.replaceChildren(); (b.criteria || []).forEach(text => {
    const item = el('li'), marker=el('span','criterion-index'); marker.setAttribute('aria-hidden','true');item.append(marker);
    const split=text.indexOf(': ');
    if(split>0 && split<100){const detail=el('details','criterion-detail');detail.append(el('summary','',text.slice(0,split)),el('p','',text.slice(split+2)));item.append(detail);}else item.append(el('span','',text));
    criteria.append(item);
  });
  $('#check-name').textContent = b.checkName; $('#target-branch').textContent = b.branch; $('#client-merger').textContent = `@${b.owner} · ${b.task?.policy?.mergeMethod === "squash" && !b.task?.mergeMethodAmendment ? "squash merge" : "any merge method"}`;
  const facts = $('#technical-facts'); facts.replaceChildren();
  fact(facts, 'Workflow', b.workflowPath); fact(facts, 'Protected files', protectedFiles(b).join('\n')); fact(facts, 'Agreement revision', b.revision);
  fact(facts, 'Escrow', b.paymentRail === 'base-usdc' && b.task?.crypto?.address ? `Base Sepolia · ${b.task.crypto.address}` : b.task?.jobId != null ? `NEAR testnet · #${b.task.jobId}` : 'Created after you accept the agreement');
  if (b.task?.fundingPolicyHash) fact(facts, 'Funding mandate', b.task.fundingPolicyHash);
  if (b.task?.policyHash) fact(facts, 'Assignment policy', b.task.policyHash);
  if (b.task?.policy?.verifier) fact(facts, 'Verifier', b.task.policy.verifier);
  $('#agreement-owner').textContent = `@${b.owner} merges to ${b.branch}. ${b.task?.policy?.mergeMethod === "squash" && !b.task?.mergeMethodAmendment ? "This existing agreement requires a squash merge." : "Any GitHub merge method is accepted."}`;
  $('#agreement-check').textContent = `${b.checkName} must succeed on the exact submitted commit, from the agreed workflow.`;
  $('.release-note span:last-child').textContent='Paid after passing checks and client merge.'; renderReward(); renderSubmission(); renderActivity(); renderAccess(); renderCheckWarning();
  $('#live-label').textContent = state.offline ? 'Connection interrupted · retrying' : 'Live';
}
function issueDetail(text) { const p = el('p', 'issue-text', text); return p; }
// One card that says what is happening and what to do next, using only backend state.
function renderIssue(b, status) {
  const t = b.task, card = $('#next-step-message'), pay = t?.payment?.state;
  card.replaceChildren(); card.className = 'issue-card issue-' + status.tone;
  const head = el('div', 'issue-head'), body = el('div', 'issue-body'), actions = el('div', 'issue-actions');
  head.append(icon(status.icon));
  const title = el('h2'); head.append(title);
  const last = [...(t?.timeline || [])].pop();
  const canRefresh = ['client', 'developer'].includes(b.role) && pay === 'NotRequested';
  const prLink = () => t?.prNumber && actions.append(link(`Open PR #${t.prNumber} ↗`, `https://github.com/${b.repository}/pull/${t.prNumber}`, 'ui-button ui-button-secondary'));
  if (t?.refund) { title.textContent = t.refund.state === 'Processed' ? 'Refunded to the creator' : 'Dispute refund processing'; body.append(issueDetail(t.refund.state === 'Processed' ? 'The confirmed refund returned the recorded unspent deposit to the fixed creator wallet. No developer reward was paid.' : 'The owner authorized a refund to the destination fixed before funding. Waiting for confirmation.')); if(/^https:\/\/sepolia\.basescan\.org\/tx\/0x[a-f0-9]{64}$/i.test(t.refund.reference || '')) actions.append(link('View refund receipt ↗', t.refund.reference, 'ui-button ui-button-secondary')); }
  else if (t?.disputed) { title.textContent = 'Release paused'; body.append(issueDetail('A dispute is open. No payment is released until it is resolved.')); }
  else if (pay === 'NeedsAttention') { title.textContent = 'Payment needs attention'; body.append(issueDetail(t.payment.error || 'The payout could not be confirmed. The payment reference and activity record its progress.')); }
  else if (t?.verdict?.status === 'blocked') {
    const reasons = t.verdict.reasons || [];
    title.textContent = reasons.length ? `Release blocked · ${reasons.length} ${reasons.length === 1 ? 'condition' : 'conditions'} not met` : 'Release blocked';
    const list = el('ul', 'issue-reasons'); reasons.forEach(reason => { const li = el('li'); li.append(icon('close'), el('span', '', reason)); list.append(li); }); body.append(list);
    if (last?.at) body.append(el('p', 'issue-time', 'Last checked ' + date(last.at)));
    prLink(); if (canRefresh) actions.append(button(state.busy?'Requesting…':'Refresh verification', () => action('refresh'), 'ui-button ui-button-secondary'));
  }
  else if (b.status === 'Draft') { title.textContent = 'Draft · not funded'; body.append(issueDetail('Accept the release agreement to set up escrow, then fund the reward. Developers can claim only after funding is confirmed.')); }
  else if (pay === 'Processed') { title.textContent = 'Paid'; body.append(issueDetail('The payment provider confirmed the payout.')); }
  else if (pay && pay !== 'NotRequested') { title.textContent = 'Payment processing'; body.append(issueDetail('Release has started. This page updates when the payout is confirmed.')); }
  else if (t?.prNumber) { title.textContent = `In review · PR #${t.prNumber}`; body.append(issueDetail(t.verdict?.status === 'eligible' ? 'All agreed conditions passed. Payment starts automatically.' : 'Waiting for the agreed check and a qualifying client merge.')); prLink(); }
  else if (t?.funded) { title.textContent = t.policy?.developerId ? `In progress · @${t.policy.developerLogin}` : 'Available to claim'; body.append(issueDetail('Funds are secured. Payment follows the agreed check and the client’s qualifying merge.')); }
  else { title.textContent = t?.jobId != null || state.deposit?.address ? 'Awaiting deposit' : 'Preparing escrow'; body.append(issueDetail('The reward is not secured until the deposit is confirmed.')); }
  card.hidden = !(t?.disputed || pay === 'NeedsAttention' || t?.verdict?.status === 'blocked');
  card.append(head, body); if (actions.childElementCount) card.append(actions);
}
// Receipt links: the exact NEAR transaction when recorded, and always the escrow contract.
function explorerRow(reference, txHash) {
  const links = explorerLinks(reference, txHash); if (!links) return null;
  const row = el('div', 'explorer-links');
  if (links.tx) row.append(link('Transaction ↗', links.tx, 'explorer-link'));
  row.append(link('Escrow contract ↗', links.contract, 'explorer-link'));
  if (!links.tx) row.append(el('small', 'explorer-note', 'Transaction link appears once its hash is confirmed.'));
  else if (links.network === 'testnet') row.append(el('small', 'explorer-note', 'Testnet explorer indexing can lag behind the chain.'));
  return row;
}
function renderReward() {
  if(state.bounty?.paymentRail === 'base-usdc') {renderCryptoReward();return;}

  const b = state.bounty; if (!b) return;
  const t = b.task, box = $('#reward-content'); box.replaceChildren();
  $('#reward-amount').textContent = money(b.amountCents); $('#funding-label').textContent = fundingState(b);
  const paid = t?.payment?.state === 'Processed'; $('#funding-pill').className = 'funding-state ' + (t?.funded ? 'is-secured' : 'is-pending');
  let heading = 'Fund this bounty', description = 'Lock the reward before anyone starts. Payment follows the agreed checks and your qualifying merge.';
  if (paid) { heading = 'Paid'; description = 'The payout is processed. The contributor’s destination and payment reference are recorded with the task.'; }
  else if (t?.payment?.state && t.payment.state !== 'NotRequested') { heading = 'Payment processing'; description = 'Release has started. The payout is tracked through NEAR and Monerium until it is confirmed.'; }
  else if (t?.funded) { heading = 'Funds secured'; description = 'The reward is locked for this bounty. It releases only after the agreed verification and client merge.'; }
  else if (b.status !== 'Draft') { heading = t?.jobId != null ? 'Awaiting deposit' : 'Preparing escrow'; description = t?.jobId != null ? 'Use the dedicated deposit instructions below. We’ll confirm the funds automatically.' : 'Your agreement is accepted. Escrow and deposit instructions are being prepared in the background.'; }
  if (b.role === 'client' && t && !t.funded && t.jobId != null && state.treasury?.configured && !state.manualBank) description = 'Fund directly from the demo wallet, or choose bank funding. We confirm the deposit automatically.';
  // The pill already states funded / processing / paid; explanatory text only when an action is needed.
  if (!(paid || t?.funded)) box.append(el('h2', '', heading), el('p', '', description));
  const celebrate = celebrationMark(b); if (celebrate) box.append(celebrate);
  if (b.role === 'client' && b.status === 'Draft') {
    if (state.me?.mode === 'sandbox' && (!state.me.bankConnected || !state.me.payout)) {
      if (!state.me.bankConnected) {
        box.append(el('p', 'action-note', 'Connect your Monerium sandbox account in NearPortal Settings before setting up escrow. Signing in to Monerium in another tab does not connect it here.'));
        box.append(link('Connect Monerium →', '/app/settings?bank&returnTo=' + encodeURIComponent('/bounties/' + b.id), 'ui-button'));
      }
      if (!state.me.payout) {
        box.append(el('p', 'action-note', 'Save your bank details for creator refunds before publishing. This destination stays fixed for the bounty.'));
        box.append(link('Save refund bank details →', '/app/settings?payout&returnTo=' + encodeURIComponent('/bounties/' + b.id), 'ui-button ui-button-secondary'));
      }
      if (state.error) { const error = el('p', 'funding-error', state.error); error.setAttribute('role', 'alert'); box.append(error); }
      return;
    }
    const escrowReady = b.paymentRail === 'base-usdc' ? state.me?.cryptoPaymentsReady : state.me?.openBountyReady;
    consent(box, `I authorize publishing this brief, locking the criteria and reward, assignment to the first eligible contributor, and automatic payout after my qualifying merge.`, state.consent === b.revision, value => { state.consent = value ? b.revision : ''; });
    if (state.busyAction === 'publish') box.append(portalWait({ phase: 'busy', title: 'Setting up your escrow', detail: 'Publishing the brief and opening a NEAR testnet escrow for this reward.', note: 'This takes a few seconds' }));
    box.append(button(state.busy ? 'Setting up…' : 'Accept & set up escrow →', publishBankBounty, 'ui-button', state.consent !== b.revision || escrowReady === false || state.checkMismatch));
    box.append(el('p', 'action-note', 'Publishes the bounty brief and starts escrow setup. Your reward stays unfunded until the deposit is confirmed.'));
    if (state.error) { const error = el('p', 'funding-error', state.error); error.setAttribute('role', 'alert'); box.append(error); }
    if (escrowReady === false) box.append(el('p', 'action-note', 'Escrow setup is currently unavailable. Your draft is saved.'));
    if (state.checkMismatch) box.append(el('p', 'action-note', 'Fix the verification check in your draft before setting up escrow.'));
  } else if (awaitingFunding(b) && t?.jobId == null) {
    box.append(portalWait({ phase: 'preparing', title: 'Creating your NEAR escrow', detail: 'Locking the agreed criteria and reward. Your deposit instructions appear here next.' }));
  } else if (b.role === 'client' && t && !t.funded && t.jobId != null && renderTreasury(box,b)) {
    // Demo wallet funding is handled above; bank funding remains an explicit alternative.
  } else if (b.role === 'client' && t && !t.funded && t.jobId != null) {
    const deposit = el('dl', 'deposit-box'); fact(deposit, 'Client deposit IBAN', state.deposit?.iban || 'Linking your escrow deposit address…'); fact(deposit, 'Reference', state.deposit?.reference || `NP-${t.jobId}`); fact(deposit, 'Exact amount', money(b.amountCents));
    box.append(deposit);
    if (state.deposit?.iban) { box.append(copyRow(state.deposit.iban)); const bankLink = link('Open Monerium sandbox ↗', 'https://sandbox.monerium.dev/receive', 'ui-button ui-button-secondary'); box.append(bankLink, el('p', 'action-note', `In your client Monerium account, match this IBAN and simulate exactly ${money(b.amountCents)}. Wait for confirmation here before work starts.`)); }
    else box.append(el('p', 'action-note', 'Instructions refresh automatically. Wait for an IBAN before adding funds.'));
    box.append(state.deposit?.iban
      ? portalWait({ phase: 'watching', title: 'Watching for your Monerium deposit', detail: `Send exactly ${money(b.amountCents)} to the IBAN above. We confirm it in escrow automatically.` })
      : portalWait({ phase: 'preparing', title: 'Linking your deposit IBAN', detail: 'The escrow is getting its Monerium sandbox deposit account.' }));
  }
  if (b.canClaim) {
    if (!state.me?.payout) box.append(link('Add payout details to claim →', '/app/settings?payout=1', 'ui-button'));
    else { consent(box, `I accept the fixed criteria and payout to ${state.me.payout.iban}. My PR must pass the agreed check and be merged by @${b.owner}.` + (b.market ? ` I get an exclusive assignment with ${deliveryText(b.market.deliveryHours)} to submit, starting when it is confirmed.` : ''), state.claimConsent === t?.policyHash, value => { state.claimConsent = value ? t.policyHash : ''; }); box.append(button('Claim this bounty →', () => action('claim', { policyHash: t.policyHash, payoutVersion: state.me.payout.version }), 'ui-button', state.claimConsent !== t.policyHash)); }
  }
  renderClaimGate(box);
  if (b.role === 'client' && t?.overpayment?.recordedCents > 0) {
    const refund = el('div', 'surplus-refund');
    refund.append(el('strong', '', 'Surplus refund'));
    for (const item of t.overpayment.refunds) {
      refund.append(el('p', '', money(item.amountCents) + ' · ' + (item.state === 'Processed' ? 'Returned to your refund account' : ['SignFailed', 'NeedsAttention'].includes(item.state) ? 'Needs attention' : 'Refund processing')));
      refund.append(el('small', '', item.reference)); if (item.state === 'Processed') { const links = explorerRow(item.reference, item.txHash); if (links) refund.append(links); }
    }
    if (!t.overpayment.refunds.length) refund.append(el('p', '', money(t.overpayment.recordedCents) + ' excess deposit awaiting reconciliation.'));
    box.append(refund);
  }
  if (t?.policy?.developerId) { const who = el('dl', 'reward-facts'); fact(who, 'Contributor', '@' + t.policy.developerLogin); box.append(who); }
  if (paid && t.payment.reference) { const receipt = el('div', 'deposit-box'), facts = el('dl'); fact(facts, 'Payment reference', t.payment.reference); if (t.payment.txHash) fact(facts, 'NEAR transaction', t.payment.txHash); receipt.append(facts); const links = explorerRow(t.payment.reference, t.payment.txHash); if (links) receipt.append(links); box.append(receipt); }
  if (t?.payment?.error && ['client', 'developer'].includes(b.role)) box.append(el('p', 'action-note', t.payment.error));
  $('#dispute-button').hidden = !(['client', 'developer'].includes(b.role) && t?.funded && t.payment.state === 'NotRequested' && !t.disputed);
}
function fundingStorageKey() { return 'nearportal:funding:' + state.me?.user?.id + ':' + state.bounty?.id; }
function rememberFunding(value) {
  state.treasurySubmission = value;
  try { if (value) sessionStorage.setItem(fundingStorageKey(), 'pending'); else sessionStorage.removeItem(fundingStorageKey()); } catch {}
}
function restoreFunding() {
  try { state.treasurySubmission = sessionStorage.getItem(fundingStorageKey()) === 'pending'; } catch {}
  if (state.bounty?.task?.funded) rememberFunding(false);
}
function progressPanel(phase, message) {
  const progress = fundingProgress(phase), panel = el('div', 'funding-progress' + (progress.issue ? ' has-issue' : '') + (progress.step === 3 ? ' is-complete' : ''));
  panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
  const heading = el('div', 'funding-progress-heading');
  const symbol = progress.busy ? el('span', 'funding-spinner') : icon(progress.issue ? 'info' : 'check'); symbol.setAttribute('aria-hidden', 'true');
  heading.append(symbol, el('strong', '', progress.title)); panel.append(heading, el('p', '', message || progress.detail));
  if (!progress.issue) {
    const steps = el('ol', 'funding-progress-steps'); steps.setAttribute('aria-label', 'Funding progress');
    ['Prepare', 'Confirm', 'Secure'].forEach((name, index) => {
      const item = el('li', index < progress.step ? 'is-done' : index === progress.step ? 'is-current' : '');
      if (index === progress.step) item.setAttribute('aria-current', 'step');
      item.append(el('span', '', index < progress.step ? '✓' : String(index + 1)), document.createTextNode(name)); steps.append(item);
    }); panel.append(steps);
  }
  panel.append(el('small', 'funding-lock-note', 'One funding attempt · repeat payment locked'));
  return panel;
}
function renderTreasury(box, b) {
  const wallet = state.treasury;
  if (state.manualBank) return false;
  if (!wallet) {
    if (!state.me?.demoTreasuryAvailable) return false;
    box.append(progressPanel('Checking', state.treasuryReadError ? 'Unable to read funding status. Your payment action remains locked while we reconnect.' : null));
    if (state.treasuryReadError) box.append(button('Check status', () => { state.treasuryAt = 0; loadTreasury(); }, 'treasury-link'));
    return true;
  }
  if (!wallet.available || !wallet.configured) return false;
  const t = b.task, policy = t.fundingPolicyHash || t.policyHash;
  const info = el('div', 'treasury-funding');
  info.append(el('strong', '', 'Demo wallet'), el('p', '', wallet.balanceCents === undefined ? 'Balance unavailable' : money(wallet.balanceCents) + ' test EURe available'));
  if (state.error || wallet.blockedReason) { const error = el('p', 'funding-error', state.error || wallet.blockedReason); error.setAttribute('role', 'alert'); info.append(error); }
  const funding = wallet.funding, locked = Boolean(funding || state.busy || state.treasurySubmission);
  if (locked) {
    const phase = funding?.state || (state.busy ? 'Preparing' : 'Checking');
    info.append(progressPanel(phase, funding?.error));
    if (/^0x[a-fA-F0-9]{64}$/.test(funding?.hash || '')) info.append(link('View funding transaction ↗', 'https://sepolia.basescan.org/tx/' + funding.hash, 'treasury-link'));
    if (!state.busy) info.append(button('Check status', () => { state.treasuryAt = 0; loadTreasury(); }, 'treasury-link'));
  } else {
    const enough = wallet.balanceCents >= b.amountCents, gas = BigInt(wallet.gasWei || '0') > 0n, within = b.amountCents <= wallet.maxCents;
    if (!enough || !gas) info.append(link('Top up the demo wallet →', '/app/treasury', 'treasury-link'));
    if (!within) info.append(el('p', '', 'This reward exceeds the demo wallet’s ' + money(wallet.maxCents) + ' limit. Use bank funding.'));
    if (wallet.error) info.append(el('p', '', wallet.error));
    consent(info, 'Use ' + money(b.amountCents) + ' of sandbox demo-wallet funds for this bounty.', state.treasuryConsent === policy, value => { state.treasuryConsent = value ? policy : ''; });
    info.append(button('Fund from demo wallet →', fundFromTreasury, 'ui-button', !enough || !gas || !within || Boolean(wallet.blockedReason) || state.treasuryConsent !== policy));
    info.append(el('p', 'action-note', 'Sends the exact reward to this escrow. Funds are secured only after the confirmed transfer is recorded on NEAR.'));
  }
  if (wallet.blockedReason && !locked) info.append(button('Refresh funding status', () => { state.treasuryAt = 0; loadTreasury(); }, 'treasury-link'));
  box.append(info, link('Manage demo wallet ↗', '/app/treasury', 'treasury-link'));
  if (!locked && !wallet.blockedReason) box.append(button('Use bank funding instead', async () => { state.manualBank = true; state.deposit = null; renderReward(); try { state.deposit = await api('/bounties/' + b.id + '/deposit'); renderReward(); } catch (error) { state.error = error.message; render(); } }, 'treasury-link'));
  return true;
}
async function fundFromTreasury() {
  const b = state.bounty, t = b?.task, policy = t?.fundingPolicyHash || t?.policyHash;
  if (state.busy || state.treasurySubmission || state.treasury?.funding || state.treasury?.blockedReason || !policy || state.treasuryConsent !== policy) return;
  state.treasuryEpoch++; rememberFunding(true); state.busy = true; state.error = ''; renderReward();
  try {
    const result = await api('/bounties/' + b.id + '/treasury-fund', { policyHash: policy });
    state.treasury.funding = result.funding; state.treasuryConsent = '';
  } catch (error) {
    state.error = error.message;
    // A transport error can hide a successful broadcast. Keep the action locked
    // until the server reports its signed intent or confirms no request is active.
    if (error.status >= 400 && error.status < 500) rememberFunding(false);
  } finally { state.busy = false; state.treasuryAt = 0; render(); loadTreasury(); }
}
async function loadTreasury() {
  if(state.bounty?.paymentRail === "base-usdc") return;
  const waiting = state.treasurySubmission || state.treasury?.funding;
  if (!state.me?.demoTreasuryAvailable || state.bounty?.role !== 'client' || state.bounty?.task?.funded || state.treasuryLoading || Date.now() - state.treasuryAt < (waiting ? 4000 : 15000)) return;
  state.treasuryLoading = true;
  const epoch = state.treasuryEpoch;
  try {
    const wallet = await api('/treasury?bounty=' + state.bounty.id);
    if (epoch !== state.treasuryEpoch) return;
    state.treasury = wallet; state.treasuryAt = Date.now(); state.treasuryReadError = false;
    if (!state.busy && wallet.configured && Object.hasOwn(wallet, 'funding') && wallet.funding === null) rememberFunding(false);
    renderReward();
  } catch { state.treasuryReadError = true; renderReward(); }
  finally { state.treasuryLoading = false; }
}

function renderCheckWarning() {
  const warning = $('#check-warning'); warning.hidden = !state.checkMismatch;
  if (state.checkMismatch) { warning.replaceChildren(el('strong', '', `“${state.bounty.checkName}” was not reported by the selected workflow.`), el('p', '', `GitHub currently reports: ${state.checkNames.join(', ')}. Edit the draft and select the check that verifies your criteria before funding.`), link('Edit verification settings →', '/app/new?draft=' + state.bounty.id, 'subtle-button')); }
}
// ---------- Deadline bounties (fixed price, exclusive assignment) ----------
// Times come from the server/chain. The countdown is computed locally from that deadline and the
// server clock offset; it never polls.
// dateStyle cannot be combined with timeZoneName: list the fields explicitly.
const dueFormat = ms => new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms));
const utc = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
const deliveryText = duration;
function assignmentStatus(title, message) {
  const panel = el('div', 'assignment-status'); panel.setAttribute('role', 'status');
  const heading = el('div', 'assignment-status-heading'), spinner = el('span', 'funding-spinner'); spinner.setAttribute('aria-hidden', 'true');
  heading.append(spinner, el('strong', '', title)); panel.append(heading, el('p', '', message));
  return panel;
}
function renderAssignment(content, b) {
  const m = b.market, a = m?.assignment, t = b.task, now = Date.now() + (state.serverOffset || 0);
  content.append(el('p', 'assignment-terms', `Exclusive assignment · ${deliveryText(m.deliveryHours)} delivery window${a?.confirmed ? '' : ' · starts on confirmation'}.`));
  const last = m.history?.at(-1);
  if (!a) {
    if (last) content.append(el('p', 'read-only-notice', last.reason === 'expired' ? 'A previous assignment expired without a timely pull request. Funds stayed in escrow; the bounty is available again.' : last.reason === 'withdrawn' ? 'The previous developer released the assignment. The bounty is available again.' : 'The previous assignment could not be confirmed by the escrow. The bounty is available again.'));
    content.append(el('p', 'read-only-notice', t?.funded ? 'Claim it to get the exclusive assignment. You get the full delivery time once the assignment is confirmed.' : 'Claims open once the reward is funded.'));
    return true;
  }
  if (!a.confirmed) {
    content.append(assignmentStatus('Assignment processing', a.mine ? 'The escrow is confirming your exclusive assignment. Your delivery time starts when the deadline appears here.' : `@${a.login} claimed this bounty. The escrow is confirming the assignment.`));
    return true;
  }
  const facts = el('dl', 'assignment-facts');
  fact(facts, 'Assigned to', a.mine ? 'You' : '@' + a.login);
  fact(facts, 'Assignment', a.marker);
  fact(facts, 'Deadline', `${dueFormat(a.deadline)} (${utc(a.deadline)})`);
  const item = el('div');
  if (a.submission) item.append(el('dt', '', 'Submitted'), el('dd', '', `${dueFormat(a.submission.receivedAt)} · on time`));
  else { item.append(el('dt', '', 'Delivery'), el('dd', '', deliveryText(m.deliveryHours))); }
  facts.append(item); content.append(facts);
  if (a.submission) {
    content.append(el('p', 'read-only-notice', `PR #${a.submission.prNumber} · commit ${a.submission.headSha.slice(0, 12)} is registered for ${a.marker}. Submission is not acceptance: the agreed check and the client's merge still apply, and can finish after the deadline.`));
    if (a.mine && now <= a.deadline) content.append(submitForm(b, a, 'Submit the new commit'), el('p', 'read-only-notice', 'Pushed a fix to the same PR? Submit again before the deadline to register the new commit. After the deadline, only the registered commit can be paid.'));
    return false; // the PR verification block follows
  }
  if (a.withdrawRequested) { content.append(assignmentStatus('Releasing assignment', 'The escrow is clearing the assignment. The bounty reopens once confirmed.')); return true; }
  if (now > a.deadline) {
    content.append(el('p', 'read-only-notice', `The deadline passed without a submission. The assignment expires when the ${m.relayGraceMinutes}-minute relay window closes; the bounty then reopens. Funds stay in escrow.`));
    return true;
  }
  const branch=suggestedBranch(b);if(branch)content.append(el('p','branch-copy-label','Branch name'),copyRow(branch,'Copy branch'));
  if (!a.mine) { content.append(el('p', 'read-only-notice', `Exclusively assigned to @${a.login} until ${dueFormat(a.deadline)}.`)); return true; }
  content.append(el('p', '', 'Put this exact line in your pull request description:'), copyRow(`NearPortal-Task: ${a.marker}`));
  const links = el('div', 'assignment-links'); links.append(link('Open code editor ↗', editorUrl(b), 'ui-button ui-button-secondary'), link('Create PR on GitHub ↗', pullRequestUrl(b), 'ui-button ui-button-secondary')); content.append(links);
  content.append(submitForm(b, a, 'Submit work'), el('p', 'read-only-notice', 'Submit before the deadline. NearPortal records the time it receives your submission and the exact commit; commit dates are not used.'));
  content.append(button('Release assignment', () => { if (confirm(`Release ${a.marker}? The bounty reopens for other developers. You cannot undo this.`)) action('withdraw', { generation: a.generation, expectedRevision: m.revision }); }, 'ui-button ui-button-secondary release-assignment'));
  return true;
}
let prFieldId = 0;
function pullRequestForm(b, initial, label, onSubmit, secondary=false) {
  const form=el('form','pr-input-row'),field=el('div','pr-input-field'),input=el('input'),id='pr-link-'+(++prFieldId);
  const caption=el('label','', 'Pull request');caption.htmlFor=id;
  input.id=id;input.type='text';input.inputMode='url';input.autocomplete='off';input.spellcheck=false;
  input.placeholder=`https://github.com/${b.repository}/pull/123`;
  input.setAttribute('aria-label','Pull request link or number');input.setAttribute('aria-describedby',id+'-feedback');
  input.value=state.pr || (initial ? `https://github.com/${b.repository}/pull/${initial}` : '');
  const feedback=el('p','pr-input-feedback','Paste the GitHub link or enter a PR number.');feedback.id=id+'-feedback';
  const validate=()=>{try{const number=parsePullRequest(input.value,b.repository);input.removeAttribute('aria-invalid');feedback.removeAttribute('role');feedback.classList.remove('is-error');feedback.textContent=`${b.repository} · PR #${number}`;return number;}catch(error){input.setAttribute('aria-invalid','true');feedback.setAttribute('role','alert');feedback.classList.add('is-error');feedback.textContent=error.message;return null;}};
  input.addEventListener('input',()=>{state.pr=input.value;if(input.value.trim())validate();else{input.removeAttribute('aria-invalid');feedback.removeAttribute('role');feedback.classList.remove('is-error');feedback.textContent='Paste the GitHub link or enter a PR number.';}});
  field.append(caption,input,feedback);
  const submit=el('button','ui-button'+(secondary?' ui-button-secondary':''),label);submit.type='submit';submit.disabled=state.busy;
  form.append(field,submit);form.addEventListener('submit',event=>{event.preventDefault();const number=validate();if(number===null){input.focus();return;}onSubmit(number);});
  if(input.value)validate();return form;
}
function submitForm(b, a, label) {
  return pullRequestForm(b,a.submission?.prNumber,label,number=>action('submit',{prNumber:number,expectedRevision:b.market.revision}).then(ok=>{if(ok)toast('Submission received. Verification follows.');}));
}
function renderSubmission() {
  const b = state.bounty, t = b.task, section = $('#submission-section');
  const fixed = b.marketTerms?.kind === 'fixed' && b.market;
  $('#submission-heading').textContent = fixed ? 'Assignment' : 'Pull request';
  if (fixed) {
    section.hidden = false;
    state.serverOffset = b.market.serverNow - Date.now();
    const content = $('#submission-content'); content.replaceChildren();
    if (renderAssignment(content, b)) return;
  } else section.hidden = !t?.funded;
  if (!t?.funded) return;
  if (!t.prNumber && b.role !== 'developer') { section.hidden = true; return; }
  const content = $('#submission-content'); if (!fixed) content.replaceChildren();
  if (!t.prNumber && b.role === 'developer') { const branch=suggestedBranch(b);if(branch)content.append(el('p','branch-copy-label','Branch name'),copyRow(branch,'Copy branch')); }
  if (!t.prNumber && b.role === 'developer') content.append(el('p', '', 'Include this exact line in your PR description. It connects the contribution to this bounty.'), copyRow(`NearPortal-Task: ${b.code}`));
  if (t.prNumber) {
    const row = el('div', 'pr-row'), name = el('div');
    name.append(el('strong', '', `PR #${t.prNumber}`), el('span', 'ui-tag', [t.policy?.developerLogin ? '@' + t.policy.developerLogin : '', t.evidence?.headSha ? 'commit ' + t.evidence.headSha.slice(0, 7) : ''].filter(Boolean).join(' · ')));
    row.append(name, link('Open on GitHub ↗', `https://github.com/${b.repository}/pull/${t.prNumber}`, 'ui-link'));
    content.append(row);
    // Blocking reasons are shown once, in the issue card at the top.
    if (t.verdict?.status !== 'blocked') {
      const passed=t.verdict?.status==='eligible'||t.payment?.state==='Processed';
      content.append(el('p','pr-verification-state',t.payment?.state==='Processed'?'Payment confirmed':passed?'Verification passed':t.evidence?.merged?'Merged · verification pending':'Verification pending'));
      if(!passed && t.verdict?.reasons?.length){const reasons=el('ul','pr-pending-reasons');t.verdict.reasons.forEach(reason=>reasons.append(el('li','',reason)));content.append(reasons);}
      else if(!passed)content.append(el('p','read-only-notice','Retrieving the latest GitHub verification results.'));
      if(!passed)content.append(el('p','read-only-notice','Funds remain secured until the agreed checks and merge conditions pass.'));
      const evidence=t.evidence;
      if(evidence){
        const required=evidence.checks?.filter(c=>c.name===b.checkName&&c.appId===b.checkAppId&&c.headSha===evidence.headSha).sort((a,b)=>b.id-a.id)[0];
        content.append(el('p','required-check-result',`Required check: ${b.checkName} · ${!required?'Not reported':required.status!=='completed'?'Running':required.conclusion==='success'?'Passed':required.conclusion||'Not passed'}`));
        const checks=el('details','reported-checks');checks.append(el('summary','',`GitHub reported checks (${new Set((evidence.checks||[]).map(c=>c.name)).size})`));
        const list=el('ul');const seen=new Set();for(const check of [...(evidence.checks||[])].sort((a,b)=>b.id-a.id)){if(seen.has(check.name))continue;seen.add(check.name);list.append(el('li','',`${check.name} · ${check.status==='completed'?check.conclusion:check.status}`));}checks.append(list);content.append(checks);
        if(evidence.observedAt)content.append(el('p','verification-time','Last checked '+date(evidence.observedAt)));
      }
      if(state.refreshRequestedAt&&(!evidence?.observedAt||Date.parse(evidence.observedAt)<Date.parse(state.refreshRequestedAt)))content.append(el('p','verification-refresh-pending','Refresh requested · waiting for the verifier. This page updates automatically.'));
    }
  } else if (b.role === 'developer') {
    content.append(link('Open code editor ↗',editorUrl(b),'ui-button'),el('p','read-only-notice','Create a work branch in the editor, make your changes, then Commit & Push.'),link('Create PR on GitHub ↗',pullRequestUrl(b),'ui-button ui-button-secondary'),el('p', 'read-only-notice', 'Select the branch containing your changes. The title and bounty identifier are prefilled. NearPortal tracks your PR automatically.'));
    content.append(pullRequestForm(b,null,'Link PR',number=>action('pr',{number}),true));
  } else content.append(el('p', 'read-only-notice', t.policy.developerId ? 'Waiting for the assigned contributor’s PR.' : 'A contributor must claim this bounty before submitting a PR.'));
  if (['client', 'developer'].includes(b.role) && t.payment?.state === 'NotRequested' && t.verdict?.status !== 'blocked') content.append(button(state.busy?'Requesting…':'Refresh verification', () => action('refresh'), 'ui-button ui-button-secondary'));
}
function renderActivity() {
  const b = state.bounty, list = $('#activity-list'); list.replaceChildren();
  const events = [...(b.task?.timeline || [])].reverse();
  if (!events.length) events.push({ at: b.createdAt, message: b.status === 'Draft' ? 'Draft saved. No funds have been locked or released.' : 'Bounty submitted. Waiting for escrow setup.' });
  const unique = events.filter((event, i) => event.message !== events[i - 1]?.message);
  $('#activity-count').textContent = `${unique.length} ${unique.length === 1 ? 'event' : 'events'}`;
  unique.slice(0, 30).forEach(event => { const item = el('li'), text = el('div'); text.append(el('p', '', event.message)); if (b.paymentRail === 'base-usdc' && event.message === 'USDC deposit confirmed on Base Sepolia and recorded in NEAR escrow.') cryptoDepositLinks(b).forEach((r,i,all) => text.append(link(all.length === 1 ? 'Verify deposit ↗' : `Verify deposit ${i+1} ↗`,r.href,'ui-link'))); if (event.at) { const time = el('time', '', date(event.at)); time.dateTime = event.at; text.append(time); } item.append(text); list.append(item); });
}
function renderAccess() {
  const b = state.bounty, section = $('#access-section'); section.replaceChildren(el('h3', '', b.private ? 'Private repository' : 'Public repository'));
  section.append(el('p', '', b.private ? b.status === 'Draft' ? 'The repository stays private. When published, the bounty brief is public; contributors need a GitHub invitation to access the code.' : 'The bounty brief is public. Code access is granted separately through GitHub invitations.' : 'Contributors can browse the code on GitHub. A funded bounty still needs to be claimed before a submission.'));
  if (b.repositoryAccess) section.append(link('Open repository ↗', `https://github.com/${b.repository}`, 'subtle-button'));
  if (b.role === 'client') (b.accessRequests || []).forEach(request => {
    const row = el('div', 'access-request'); row.append(el('span', '', '@' + request.login));
    if (request.status === 'requested') row.append(button('Invite · Write access', () => { if (confirm(`Invite @${request.login} to ${b.repository} with Write access? They will be able to read code and push branches.`)) action('invite', { userId: request.userId, permission: 'push' }); }, ''));
    else row.append(el('span', '', request.status === 'accepted' ? 'Access unlocked' : 'Invitation sent')); section.append(row);
  });
}
async function validateCheck(b) {
  if (b.role !== 'client' || b.status !== 'Draft' || state.checkedRevision === b.revision) return;
  state.checkedRevision = b.revision; state.checkMismatch = false;
  try { const result = await api('/workflow-checks?repository=' + encodeURIComponent(b.repository) + '&workflow=' + encodeURIComponent(b.workflowPath)); if (state.bounty?.revision !== b.revision) return; state.checkNames = result.checkNames || []; state.checkMismatch = Boolean(state.checkNames.length && !state.checkNames.includes(b.checkName)); renderCheckWarning(); renderReward(); } catch { /* Existing policy still enforces the exact check; unavailable discovery is not success. */ }
}
async function load() {
  if (state.busy) return;
  try {
    const result = await api('/bounties/' + id); state.offline = false;
    const signature = JSON.stringify(result.bounty);
    if (signature !== state.last) {
      const wasWaiting = state.bounty?.id === result.bounty.id && awaitingFunding(state.bounty);
      state.bounty = result.bounty; state.last = signature; restoreFunding();
      if (wasWaiting && result.bounty.task?.funded && result.bounty.role === 'client') { state.celebrateAt = Date.now(); setTimeout(() => { if (state.celebrateAt && Date.now() - state.celebrateAt >= CELEBRATION_MS) { state.celebrateAt = 0; render(); } }, CELEBRATION_MS + 50); }
      render(); validateCheck(result.bounty);
    }
    // While the creator waits on escrow or a deposit, refresh every ~5 s (the server bounds the work).
    const waiting = awaitingFunding();
    if (waiting) document.documentElement.dataset.npWaiting = ''; else delete document.documentElement.dataset.npWaiting;
    clearTimeout(state.fastTimer); if (waiting && !document.hidden) state.fastTimer = setTimeout(() => state.poller?.now(), 5000);
    if (state.bounty?.role === 'client' && (state.bounty.task?.jobId != null || state.bounty.paymentRail === 'base-usdc' && state.bounty.task?.crypto) && !state.bounty.task.funded && !(state.deposit?.iban || state.deposit?.address)) {
      try { state.deposit = await api(`/bounties/${id}/deposit`); state.depositError = ''; render(); } catch (error) { state.depositError = error.message; render(); }
    }
    loadTreasury();
    $('#live-label').textContent = 'Live';
    return true;
  } catch (error) { state.offline = true; if (!state.bounty) { $('#loading-title').textContent = 'This bounty isn’t available.'; $('#loading-copy').textContent = error.message; $('#loading-login').hidden = false; } else $('#live-label').textContent = 'Connection interrupted · retrying'; return false; }
}
$('#dispute-button').addEventListener('click', () => { if (confirm('Pause automatic release and open a dispute for mediator review?')) action('dispute'); });
if (!validBountyId(id)) { $('#loading-title').textContent = 'Invalid bounty link.'; $('#loading-copy').textContent = 'Open a bounty from your workspace.'; }
else {
  try { state.me = await api('/me'); } catch { state.me = null; }
  renderIdentity(); await load();
  // Detail refresh every ~10 s (jittered, paused in hidden tabs, backing off on errors).
  const poller = poll(load, { interval: 10000, focus: false }); state.poller = poller;
  // Returning from Settings (focus, tab switch or back navigation) re-reads /me so Monerium and refund prerequisites are current.
  let focusCheckedAt = Date.now();
  const refreshMe = async () => {
    if (Date.now() - focusCheckedAt < 2000) return; focusCheckedAt = Date.now();
    let changed = false;
    try {
      const me = await api('/me');
      if (me.user?.id !== state.me?.user?.id) {
        state.bounty = null; state.last = ''; state.deposit = null; state.depositError = ''; state.treasury=null; state.treasuryAt=0; state.treasuryConsent=''; state.manualBank=false; state.treasurySubmission=false; state.treasuryReadError=false; state.consent = ''; state.claimConsent = ''; state.checkedRevision = ''; state.checkMismatch = false;
        $('#bounty-content').hidden = true; $('#loading').hidden = false;
      }
      changed = JSON.stringify(me) !== JSON.stringify(state.me); state.me = me;
    } catch {}
    await poller.now(); if (changed) render(); else renderIdentity();
  };
  window.addEventListener('focus', refreshMe);
  window.addEventListener('pageshow', event => { if (event.persisted) refreshMe(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshMe(); });
}

function renderClaimGate(box) {
 const b=state.bounty,t=b.task;
 if(b.canClaim || b.role==='client' || t?.policy?.developerId || !t?.funded)return;
 const reconnect='/auth/github?returnTo='+encodeURIComponent('/bounties/'+b.id);
 if(!state.me?.user){box.append(link('Sign in with GitHub to claim',reconnect,'ui-button'));return;}
 if(b.role==='visitor' && !b.repositoryAccess){
  if(b.repositoryAccessIssue==='reconnect'){
   box.append(el('h3','claim-heading','Reconnect GitHub'),el('p','action-note','Verify your repository access to claim.'),link('Reconnect GitHub',reconnect,'ui-button'));return;
  }
  if(b.repositoryAccessIssue==='unavailable'){
   box.append(el('p','action-note','GitHub access could not be verified. Claiming is paused until access is confirmed.'),button('Recheck GitHub access',()=>action('check-access'),'ui-button ui-button-secondary'),link('Reconnect GitHub',reconnect,'ui-link'));return;
  }
  const heading=el('h3','claim-heading','Private repository');heading.prepend(icon('lock'));box.append(heading,el('p','action-note','Repository access is required to claim.'));
  if(b.accessRequest?.status==='invited')box.append(link('Accept GitHub invitation ↗','https://github.com/notifications','ui-button'));
  else if(b.accessRequest?.status==='requested')box.append(el('p','action-note','Access requested.'),button('Check access',()=>action('check-access'),'ui-button'));
  else box.append(button('Request access',()=>action('request-access'),'ui-button'));
  if(b.accessRequest?.status!=='requested')box.append(button(b.accessRequest?'Check access':'Already invited? Check access',()=>action('check-access'),'claim-recheck'));
 }
}

function renderCryptoReward() {
 const b=state.bounty,t=b.task,box=$('#reward-content');box.replaceChildren();
 $('#reward-amount').textContent=money(b.amountCents);
 const paid=t?.payment?.state==='Processed',attention=t?.payment?.state==='NeedsAttention',processing=t?.payment?.state && !['NotRequested','Processed','NeedsAttention'].includes(t.payment.state);
 $('#funding-label').textContent=paid?'Payment confirmed on Base Sepolia':attention?'Payment needs attention':t?.disputed?'Release paused':processing?'Payment processing':t?.funded?'Funds secured on Base Sepolia':'Not funded';
 $('#funding-pill').className='funding-state '+(t?.funded?'is-secured':'is-pending');
 if(t?.funded){
  const receipts=cryptoDepositLinks(b);
  if(receipts.length===1)box.append(link('Verify deposit ↗',receipts[0].href,'ui-link deposit-proof'));
  else if(receipts.length>1){const details=el('details','deposit-receipts');details.append(el('summary','',`Verify ${receipts.length} deposits`));receipts.forEach((r,i)=>details.append(link(`Deposit ${i+1} ↗`,r.href,'ui-link')));box.append(details);}
  else box.append(el('p','action-note','Retrieving deposit receipt…'));
 }
 const celebrate=celebrationMark(b); if(celebrate) box.append(celebrate);
 if(b.role==='client'&&b.status==='Draft') {
   consent(box,'I accept this fixed USDC reward and automatic payment after a verified qualifying merge. Surplus deposits have no automatic refund in this test.' + (b.market ? ` I get an exclusive assignment with ${deliveryText(b.market.deliveryHours)} to submit, starting when it is confirmed.` : ''),state.consent===b.revision,value=>{state.consent=value?b.revision:'';});
   if(state.busyAction==='publish')box.append(portalWait({phase:'busy',title:'Creating your deposit address',detail:'Publishing the brief and preparing a dedicated Base Sepolia address.',note:'This takes a few seconds'}));
   box.append(button(state.busy?'Setting up…':'Accept & create deposit address',()=>action('publish',{revision:b.revision}),'ui-button',state.consent!==b.revision||!state.me?.cryptoPaymentsReady||state.checkMismatch));
   if(!state.me?.cryptoPaymentsReady)box.append(el('p','action-note','USDC test payments are being configured. Your draft can be saved; do not send funds yet.'));
 } else if(b.role==='client' && t && !t.funded) {
   if(state.deposit?.address){box.append(el('strong','','Send exactly '+money(b.amountCents)),copyRow(state.deposit.address, 'Copy address'),el('p','action-note','USDC token: '+state.deposit.token),el('p','action-note','Network: Base Sepolia (84532). Wait for on-chain confirmations before claims open.'));
    box.append(portalWait({phase:'watching',title:'Watching Base Sepolia for your deposit',detail:'Once it has 12 confirmations, it is recorded in the NEAR escrow — usually within a couple of minutes.'}));
   } else box.append(portalWait({phase:'preparing',title:'Preparing your deposit address',detail:'Creating and verifying a dedicated Base Sepolia address for this bounty.'}));
   if(t.crypto?.depositedUnits && BigInt(t.crypto.depositedUnits)>0n)box.append(el('p','action-note','Confirmed deposit: '+(Number(t.crypto.depositedUnits)/1e6).toFixed(6)+' USDC'));
 }
 if(t?.crypto?.surplusUnits && BigInt(t.crypto.surplusUnits)>0n)box.append(el('p','action-note','Surplus held separately: '+(Number(t.crypto.surplusUnits)/1e6).toFixed(6)+' USDC. Manual review; no automatic refund.'));
 renderClaimGate(box);
 if(b.canClaim) {
  box.append(el('h3','claim-heading','Claim this bounty'));
  const label=el('label','wallet-label','Payout wallet');
  const input=el('textarea','ui-input payout-address');input.rows=2;input.placeholder='Paste your 0x… wallet address';input.autocomplete='off';input.spellcheck=false;input.value=state.walletAddress;input.setAttribute('aria-describedby','wallet-address-feedback');label.append(input);box.append(label);
  const feedback=el('p','address-feedback');feedback.id='wallet-address-feedback';feedback.setAttribute('aria-live','polite');box.append(feedback);
  const review=button('Review & claim',()=>reviewCryptoClaim(state.walletAddress));box.append(review);
  const validate=()=>{state.walletAddress=input.value.trim();const valid=/^0x[0-9a-fA-F]{40}$/.test(state.walletAddress)&&!/^0x0{40}$/i.test(state.walletAddress);review.disabled=!valid||state.busy;input.setAttribute('aria-invalid',String(Boolean(state.walletAddress)&&!valid));feedback.textContent=!state.walletAddress?'Base Sepolia · USDC':valid?'✓ Address format valid · review before signing':'Enter a complete wallet address: 0x + 40 characters.';feedback.className='address-feedback '+(valid?'is-valid':'');};
  input.addEventListener('input',validate);validate();
  box.append(el('p','action-note','Confirm your address, then sign in your wallet to claim.'));

 }
 if(t?.policy?.developerId)box.append(el('p','assignment-line',(paid?'Paid to ':processing?'Paying ':attention?'Assigned to ':'Claimed by ')+ '@'+t.policy.developerLogin));
 if(t?.funded && !t.policy?.developerId && b.role==='client')box.append(el('p','claim-heading','Waiting for a contributor.'));
 if(t?.payment?.reference)box.append(link(t.payment.state==='Processed'?'View confirmed USDC payment':'Track USDC payment',t.payment.reference,'ui-link'));
 if(t?.payment?.error && ['client','developer'].includes(b.role))box.append(el('p','action-note',t.payment.error));
 $('#dispute-button').hidden=!(['client','developer'].includes(b.role)&&t?.funded&&t.payment.state==='NotRequested'&&!t.disputed);
}

async function reviewCryptoClaim(address) {
 if(document.querySelector('.claim-dialog'))return;
 const b=state.bounty,t=b.task,previous=document.activeElement;
 const dialog=el('dialog','claim-dialog');dialog.setAttribute('aria-labelledby','claim-dialog-title');
 const heading=el('h2','','Confirm your payout wallet');heading.id='claim-dialog-title';
 const description=el('p','action-note','This wallet will receive the reward after passing checks and the client’s qualifying merge.');
 const facts=el('dl','claim-review-facts');fact(facts,'Reward',money(b.amountCents));fact(facts,'Network','Base Sepolia · testnet');fact(facts,'Payout wallet',address);
 const status=el('p','claim-dialog-status','You will sign a message to verify ownership. No payment is sent now.');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
 const actions=el('div','claim-dialog-actions');let pending=false;
 const close=()=>{if(pending)return;dialog.close();dialog.remove();if(previous?.isConnected)previous.focus();else document.querySelector('#reward-content button')?.focus();};
 const cancel=button('Edit address',close,'ui-button ui-button-secondary');
 const confirm=button('Verify & claim',async()=>{
  pending=true;confirm.disabled=true;cancel.disabled=true;confirm.textContent='Waiting for wallet…';status.textContent='Open your wallet and approve the signature request.';
  try {
   if(!window.ethereum)throw new Error('Open NearPortal in a browser with MetaMask or another Ethereum wallet, then try again.');
   const accounts=await window.ethereum.request({method:'eth_requestAccounts'});const wallet=String(accounts[0]||'').toLowerCase();
   if(address.toLowerCase()!==wallet)throw new Error('Your connected wallet does not match this payout address. Switch accounts in your wallet or edit the address.');
   const proof=await api(`/bounties/${b.id}/wallet-challenge`,{walletAddress:wallet});
   const message='0x'+Array.from(new TextEncoder().encode(proof.message),v=>v.toString(16).padStart(2,'0')).join('');
   const signature=await window.ethereum.request({method:'personal_sign',params:[message,wallet]});
   confirm.textContent='Confirming claim…';status.textContent='Signature received. Confirming your bounty claim…';
   const success=await action('claim',{walletAddress:wallet,nonce:proof.nonce,signature,policyHash:t.policyHash});
   if(!success)throw new Error(state.error||'Claim could not be confirmed. Please try again.');
   heading.textContent='Bounty claimed';status.textContent='Your payout wallet is verified. You can now start work and submit your pull request.';confirm.hidden=true;cancel.textContent='Done';pending=false;cancel.disabled=false;cancel.focus();
  }catch(error){pending=false;status.textContent=error.code===4001?'Signature cancelled. Your bounty has not been claimed.':error.message;confirm.disabled=false;cancel.disabled=false;confirm.textContent='Try again';}
 });
 actions.append(cancel,confirm);dialog.append(heading,description,facts,status,actions);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});document.body.append(dialog);dialog.showModal();cancel.focus();
}

function renderMilestones(b){
 const steps=bountyMilestones(b),active=steps.findIndex(step=>!step.done);
 renderJourney($('#bounty-flow'),steps.map((step,index)=>({name:step.label,note:step.detail,state:step.done?'done':index===active?'current':'todo',alert:index===active&&(b.task?.verdict?.status==='blocked'||b.task?.payment?.state==='NeedsAttention'||b.task?.disputed)})));
}
let journeyWidth=0;
new ResizeObserver(entries=>{const width=Math.round(entries[0].contentRect.width);if(width!==journeyWidth){journeyWidth=width;if(state.bounty)renderMilestones(state.bounty);}}).observe($('#bounty-flow'));
