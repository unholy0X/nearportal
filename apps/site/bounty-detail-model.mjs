export function bountyStage(bounty) {
  const task = bounty.task;
  if (task?.payment?.state === 'Processed') return 4;
  if (task?.payment?.state && task.payment.state !== 'NotRequested') return 3;
  if (task?.prNumber) return 2;
  if (task?.funded) return 1;
  return 0;
}
export function fundingState(bounty) {
  if (bounty.task?.payment?.state === 'Processed') return 'Paid · payment confirmed';
  if (bounty.task?.funded) return 'Funds secured';
  if (bounty.status === 'Draft') return 'Not funded';
  if (bounty.task?.jobId != null) return 'Awaiting deposit';
  return 'Preparing escrow';
}
export function protectedFiles(bounty) {
  return [...new Set([bounty.workflowPath, ...String(bounty.protectedPaths || '').split(/[\n,]+/)].map(path => path?.trim()).filter(Boolean))];
}
export function validBountyId(value) { return /^(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|NP-[A-F0-9]{10})$/.test(value || ''); }
/** Explorer links for an escrow payout reference "near:<contract>:<payoutId>" and its optional tx hash. */
export function explorerLinks(reference, txHash) {
  const match = /^near:([a-z0-9._-]+\.(testnet|near)):(\d+)$/.exec(reference || '');
  if (!match) return null;
  const [, contract, network, payoutId] = match, base = network === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io';
  return {
    network, payoutId: Number(payoutId),
    contract: `${base}/address/${contract}`,
    tx: /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(txHash || '') ? `${base}/txns/${txHash}` : null,
  };
}
/** The five journey stops with factual sub-labels. `state` is done | current | todo; `alert` marks a blocked current stop. */
export function journeySteps(bounty, { attention = false } = {}) {
  const t = bounty.task, pay = t?.payment?.state, current = bountyStage(bounty);
  const dev = t?.policy?.developerId && t.policy.developerLogin ? '@' + t.policy.developerLogin : '';
  const notes = [
    t?.funded ? 'Funds secured' : bounty.status === 'Draft' ? 'Draft · not funded' : t?.jobId != null ? 'Awaiting deposit' : 'Preparing escrow',
    dev || (t?.funded ? 'Open to claim' : 'After funding'),
    t?.prNumber ? `PR #${t.prNumber}${t.verdict?.status === 'blocked' ? ' · blocked' : t.verdict?.status === 'eligible' || pay && pay !== 'NotRequested' ? ' · verified' : ''}` : 'Waiting for PR',
    pay === 'Processed' ? 'Released' : pay === 'NeedsAttention' ? 'Needs attention' : t?.disputed ? 'Paused' : pay && pay !== 'NotRequested' ? 'Processing' : 'After merge',
    pay === 'Processed' ? 'Payment confirmed' : 'Receipt pending',
  ];
  return ['Fund', 'Build', 'Review', 'Payment', 'Paid'].map((name, i) => ({
    name, note: notes[i],
    state: i < current || (i === 4 && pay === 'Processed') ? 'done' : i === current ? 'current' : 'todo',
    alert: i === current && attention && pay !== 'Processed',
  }));
}

/** Links come only from persisted, confirmed deposit receipts, never from arbitrary URLs. */
export function cryptoDepositLinks(bounty) {
  if (bounty.paymentRail !== 'base-usdc' || !bounty.task?.funded) return [];
  const transactions = new Map();
  const events = new Set();
  for (const d of bounty.task.crypto?.deposits || []) {
    if (!/^0x[0-9a-f]{64}$/i.test(d.txHash || '') || !/^\d+$/.test(d.units || '') || BigInt(d.units) <= 0n || !Number.isSafeInteger(d.logIndex) || d.logIndex < 0 || !/^\d+$/.test(d.blockNumber || '')) continue;
    const txHash = d.txHash.toLowerCase(), key = txHash + ':' + d.logIndex;
    if (events.has(key)) continue; events.add(key);
    const previous = transactions.get(txHash);
    transactions.set(txHash, { txHash, href: 'https://sepolia.basescan.org/tx/' + txHash, units: String(BigInt(previous?.units || '0') + BigInt(d.units)) });
  }
  return [...transactions.values()];
}

// Independent facts: a merge never implies that verification or payment passed.
export function bountyMilestones(b) {
 const t=b.task,paid=t?.payment?.state==='Processed';
 const checks=paid||t?.verdict?.status==='eligible'||(t?.verdict?.status==='pending'&&t.verdict.reasons?.length===1&&t.verdict.reasons[0]==='Waiting for the client to merge the PR.');
 const merged=Boolean(t?.evidence?.merged||paid);
 const assigned=Boolean(t?.policy?.developerId);
 const processing=['Authorized','Signing','Signed','Submitted'].includes(t?.payment?.state);
 return [
 {label:'Funded',done:Boolean(t?.funded),detail:t?.funded?'Funds secured':'Awaiting deposit'},
 {label:'Claimed',done:assigned,detail:assigned?'@'+t.policy.developerLogin:'Open to claim'},
 {label:'Checks',done:Boolean(checks),detail:checks?'Verified':t?.verdict?.status==='blocked'?'Needs attention':t?.prNumber?'Verification pending':'Waiting for PR'},
 {label:'Merged',done:merged,detail:merged?'Merge recorded':'Awaiting client'},
 {label:'Paid',done:paid,detail:paid?'Payment confirmed':t?.payment?.state==='NeedsAttention'?'Needs attention':processing?'Processing':'Not released'},
 ];
}

/** Suggested Git branch; the assignment marker also distinguishes reclaims and duplicate titles. */
export function suggestedBranch(bounty) {
  const assignment = bounty.market?.assignment;
  const login = assignment?.login || bounty.task?.policy?.developerLogin;
  if (!login || login === 'Unclaimed') return null;
  const slug = (value, limit) => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, limit).replace(/-+$/g, '');
  const user = slug(login, 39), marker = slug(assignment?.marker || bounty.code, 40);
  if (!user || !marker) return null;
  return `dev/${user}/${slug(bounty.title, 60) || 'task'}-${marker}`;
}

/** Resolve a pasted PR link without following it or accepting a different repository. */
export function parsePullRequest(value, repository) {
  const text = String(value || '').trim();
  let number;
  if (/^#?\d+$/.test(text)) number = Number(text.replace(/^#/, ''));
  else {
    let url;
    try { url = new URL(text); } catch { throw new Error('Paste a GitHub pull request link or enter its number.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) throw new Error('Use a https://github.com pull request link.');
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?$/);
    if (!match) throw new Error('Paste a pull request link, not an issue or repository link.');
    if (`${match[1]}/${match[2]}`.toLowerCase() !== String(repository).toLowerCase()) throw new Error(`This PR must belong to ${repository}.`);
    number = Number(match[3]);
  }
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Enter a valid pull request link or number.');
  return number;
}
