// NearPortal workspace model — canonical source: apps/site/workspace-model.mjs.
// Copied byte-for-byte into apps/server/src/workspace by `npm run sync:workspace`.
// Every status is derived from authoritative backend state. Nothing here invents funding,
// bids, deadlines or payments; a merge alone never produces "Paid".

const PROCESSING = new Set(['Authorized', 'Signing', 'Signed', 'Submitted']);

export const STATUSES = Object.freeze({
  toFund: { label: 'To fund', tone: 'pending', icon: 'coins', stage: 'fund' },
  available: { label: 'Available', tone: 'secured', icon: 'shield', stage: 'work' },
  bidding: { label: 'Bidding', tone: 'active', icon: 'gavel', stage: 'work' },
  awaitingConfirmation: { label: 'Awaiting confirmation', tone: 'pending', icon: 'clock', stage: 'work' },
  inProgress: { label: 'In progress', tone: 'active', icon: 'code', stage: 'work' },
  inReview: { label: 'In review', tone: 'active', icon: 'pr', stage: 'review' },
  paymentProcessing: { label: 'Payment processing', tone: 'active', icon: 'arrows', stage: 'payment' },
  refunded: { label: 'Refunded', tone: 'pending', icon: 'arrows', stage: 'paid' },
  paid: { label: 'Paid', tone: 'success', icon: 'check', stage: 'paid' },
  attention: { label: 'Needs attention', tone: 'attention', icon: 'alert', stage: 'review' },
});

/** Sealed-bid phases from the market engine (apps/server/server/portal/market.ts, Market["phase"]).
 *  "offered" = the selected winner has not yet confirmed. Shown only when the backend enables
 *  sealed bids and reports the phase; today `bountyModeCapabilities.sealedBid` is false. */
export const MARKET_PHASES = Object.freeze({ bidding: 'bidding', offered: 'awaitingConfirmation' });
function marketPhase(b, capabilities) {
  if (b.marketTerms?.kind !== 'auction') return null;
  if (capabilities?.sealedBid !== true) return 'disabled';
  return MARKET_PHASES[b.market?.phase] ?? 'unknown';
}

/** Fixed price + delivery deadline (backend `market` view). Deadlines are server/chain times. */
function deadlineMarket(b) { return b.marketTerms?.kind === 'fixed' ? b.market ?? null : null; }
export function formatDue(ms, locale) {
  try { return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(ms)); }
  catch { return new Date(ms).toISOString(); }
}

export function bountyStatus(b, { capabilities } = {}) {
  const t = b.task, pay = t?.payment?.state;
  const make = (key, detail = '') => ({ key, ...STATUSES[key], detail });
  // Open bounties carry developerId 0 with the placeholder login "Unclaimed": that is nobody.
  const dev = t?.policy?.developerId && t.policy.developerLogin ? '@' + t.policy.developerLogin : '';
  if (t?.refund?.state === 'Processed') return make('refunded', 'Returned to the creator');
  if (t?.refund) return { ...make('attention', 'Dispute refund processing'), stage: 'payment' };
  if (pay === 'Processed') return make('paid', dev);
  if (t?.disputed) return { ...make('attention', 'Release paused'), stage: 'payment' };
  if (pay === 'NeedsAttention') return { ...make('attention', 'Payment needs attention'), stage: 'payment' };
  if (PROCESSING.has(pay)) return make('paymentProcessing', t?.prNumber ? `PR #${t.prNumber}` : '');
  if (t?.verdict?.status === 'blocked') return make('attention', 'Verification blocked');
  if (b.status === 'NeedsAttention') return { ...make('attention', b.error ? 'Setup needs attention' : 'Needs attention'), stage: t?.funded ? 'work' : 'fund' };
  const fixed = deadlineMarket(b), a = fixed?.assignment;
  if (b.marketTerms?.kind === 'fixed' && t?.funded && capabilities && capabilities.fixedDeadline !== true) return { ...make('attention', 'Deadline mode not enabled'), stage: 'work' };
  if (t?.prNumber) { const status=make('inReview', [dev, `PR #${t.prNumber}`].filter(Boolean).join(' · ')); if(a?.submission)status.label='Submitted'; if(t.evidence?.merged)status.label='Merged · verification pending'; return status; }
  if (!t?.funded) {
    const usdc = (b.paymentRail ?? t?.policy?.paymentRail) === 'base-usdc';
    const depositReady = usdc ? Boolean(t?.crypto?.address && t.crypto.verifiedFundingHash && t.crypto.verifiedFundingHash === t.fundingPolicyHash) : t?.jobId != null;
    const detail = b.status === 'Draft' ? 'Draft' : depositReady ? 'Awaiting deposit' : 'Preparing escrow';
    return make('toFund', dev ? `${detail} · ${dev}` : detail);
  }
  if (t.policy?.developerId) {
    if (a && !a.confirmed) { const s = make('inProgress', dev); s.label = 'Assignment processing'; s.tone = 'pending'; s.icon = 'clock'; return s; }
    if (a?.withdrawRequested) { const s = make('inProgress', dev); s.label = 'Releasing assignment'; s.tone = 'pending'; return s; }
    if (a?.deadline) return make('inProgress', [dev, 'due ' + formatDue(a.deadline)].filter(Boolean).join(' · '));
    return make('inProgress', dev);
  }
  // A funded sealed-bid bounty is never "Available": it is bidding, awaiting the winner, or misconfigured.
  const market = marketPhase(b, capabilities);
  if (market === 'disabled') return { ...make('attention', 'Sealed-bid mode not enabled'), stage: 'work' };
  if (market === 'unknown') return { ...make('attention', 'Bid status unavailable'), stage: 'work' };
  if (market) return make(market, '');
  return make('available', 'Funds secured');
}

export const COLUMNS = Object.freeze({
  client: [
    { id: 'fund', title: 'To fund', stages: ['fund'], empty: 'Nothing to fund.' },
    { id: 'work', title: 'Funded', stages: ['work'], empty: 'No funded bounties.' },
    { id: 'review', title: 'Review & payment', stages: ['review', 'payment'], empty: 'Nothing to review.' },
    { id: 'paid', title: 'Paid', stages: ['paid'], empty: 'No payments yet.' },
  ],
  developer: [
    { id: 'work', title: 'In progress', stages: ['fund', 'work'], empty: 'No work in progress.' },
    { id: 'review', title: 'In review', stages: ['review'], empty: 'No pull requests in review.' },
    { id: 'payment', title: 'Payment', stages: ['payment'], empty: 'No payments processing.' },
    { id: 'paid', title: 'Paid', stages: ['paid'], empty: 'No payments yet.' },
  ],
});

export function columnFor(b, role = 'client', options) {
  const stage = bountyStatus(b, options).stage;
  return COLUMNS[role].find(column => column.stages.includes(stage))?.id ?? COLUMNS[role][0].id;
}

export function editorUrl(b) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(b.repository || '')) return '/bounties/' + encodeURIComponent(b.id);
  return `https://github.dev/${b.repository}/tree/${encodeURIComponent(b.branch || 'main')}`;
}

/** Open GitHub's compare page; the contributor chooses their existing work branch. */
export function pullRequestUrl(b) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(b.repository || '')) return '/bounties/' + encodeURIComponent(b.id);
  if (b.preparedPrUrl) {
    try { const prepared=new URL(b.preparedPrUrl); if(prepared.origin==='https://github.com' && prepared.pathname.startsWith('/'+b.repository+'/compare/')) return prepared.href; } catch {}
  }
  // Deadline bounties are tied to the current assignment marker (e.g. NP-0123456789-A2).
  const marker = deadlineMarket(b)?.assignment?.marker || b.code || '';
  const lines=[`NearPortal-Task: ${marker}`, '', '## Changes', '<!-- Describe your implementation. -->', '', '## Verification', '<!-- Describe the tests performed and their results. -->'];
  const params=new URLSearchParams({expand:'1',quick_pull:'1',title:b.title,body:lines.join('\n')});
  return `https://github.com/${b.repository}/compare/${encodeURIComponent(b.branch || 'main')}?${params}`;
}

export function nextAction(b, role = 'client', options) {
  const s = bountyStatus(b, options), href = '/bounties/' + b.id, t = b.task;
  const go = (label, target = href, external = false) => ({ label, href: target, external });
  if (s.key === 'refunded') return go('Refund receipt');
  if (s.key === 'paid') return go('Receipt');
  if (s.key === 'paymentProcessing') return go('Track payment');
  if (s.key === 'attention') return go('Review issue');
  if (role === 'developer') {
    if (s.key === 'inReview') return go('View checks');
    if (s.key === 'inProgress' && deadlineMarket(b)) return go(deadlineMarket(b)?.assignment?.confirmed ? 'Submit work' : 'View assignment');
    if (s.key === 'inProgress') return go('Open editor', editorUrl(b), true);
    return go('View bounty');
  }
  if (s.key === 'inReview') return go('Review PR', `https://github.com/${b.repository}/pull/${t.prNumber}`, true);
  if (s.key === 'toFund') return go(b.status === 'Draft' ? 'Fund bounty' : 'Continue funding');
  if (s.key === 'inProgress') return go('Track work');
  return go('View bounty');
}

export function scopeBounties(items, user, role = 'client') {
  if (!user) return [];
  return items.filter(b => role === 'developer' ? b.task?.policy?.developerId === user.id : b.ownerId === user.id);
}

export function filterBounties(items, { query = '', repository = '' } = {}) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return items.filter(b => (!repository || b.repository === repository) && terms.every(term =>
    [b.title, b.code, b.repository, b.task?.policy?.developerLogin].filter(Boolean).join(' ').toLocaleLowerCase().includes(term)
  )).sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || String(a.id).localeCompare(String(b.id)));
}

export const money = (cents, rail) => rail === "base-usdc" ? `${(cents/100).toFixed(2)} USDC` : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

/** Compact, zero-free summary. Paid totals count only confirmed (Processed) payments. */
export function summary(items, role = 'client', options) {
  if (!items.length) return [];
  const counts = {}; let paidCents = 0, securedCents = 0, paidUSDC = 0, securedUSDC = 0;
  for (const b of items) {
    const s = bountyStatus(b, options);
    counts[s.key] = (counts[s.key] || 0) + 1;
    if (s.key === 'paid') { if(b.paymentRail==='base-usdc') paidUSDC+=b.amountCents; else paidCents+=b.amountCents; }
    else if (s.key !== 'refunded' && b.task?.funded) {if(b.paymentRail==='base-usdc') securedUSDC+=b.amountCents;else securedCents+=b.amountCents;}
  }
  const parts = [];
  const add = (key, text) => { if (counts[key]) parts.push(`${counts[key]} ${text}`); };
  if (role === 'client') { add('toFund', 'to fund'); add('available', 'available'); }
  add('refunded', 'refunded'); add('inProgress', 'in progress'); add('inReview', 'in review'); add('paymentProcessing', 'payment processing'); if (counts.attention) parts.push(`${counts.attention} ${counts.attention === 1 ? 'needs' : 'need'} attention`);
  if (role === 'client' && securedCents) parts.push(`${money(securedCents)} secured in escrow`);
  if (paidCents) parts.push(`${money(paidCents)} ${role === 'developer' ? 'received' : 'paid out'}`);
  if(role==='client' && securedUSDC) parts.push(`${money(securedUSDC,"base-usdc")} secured in escrow`);
  if(paidUSDC) parts.push(`${money(paidUSDC,"base-usdc")} ${role==='developer'?'received':'paid out'}`);
  return parts;
}
