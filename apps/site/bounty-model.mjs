export const templates = {
  near: {
    label: 'NEAR smart contract', icon: 'layers',
    title: 'Add NEAR escrow receipts',
    description: 'Add verifiable receipts for funded bounties. Read the escrow funding state from NEAR, link its funding transaction, and keep pending deposits unconfirmed until the deposit is confirmed.',
    checkName: 'escrow-receipts',
    criteria: [
      { title: 'Read on-chain funding', detail: 'Read the bounty’s confirmed funding amount and state from the NEAR escrow contract.' },
      { title: 'Link the funding transaction', detail: 'Show the matching funding transaction with a link to its block explorer receipt.' },
      { title: 'Keep pending funds unconfirmed', detail: 'Pending or failed deposits must never display a “Funds secured” status.' },
    ],
  },
  payments: {
    label: 'Cross-chain payments', icon: 'arrows',
    title: 'Add a cross-chain payout tracker',
    description: 'Connect the NEAR escrow release to the destination-chain transaction and processed payment receipt. Make every step of the payout visible.',
    checkName: 'payout-tracker',
    criteria: [
      { title: 'Identify the destination', detail: 'Display the expected network and recipient for the payout.' },
      { title: 'Link the payout transaction', detail: 'Link to the correct destination-chain transaction.' },
      { title: 'Separate processing from completed', detail: 'Only mark a payout completed after the payment provider confirms processing.' },
    ],
  },
  agents: {
    label: 'Agent security', icon: 'shield',
    title: 'Add spending limits for agent-funded bounties',
    description: 'Enforce the owner’s per-task and daily spending limits before an agent can fund a bounty.',
    checkName: 'spending-limits',
    criteria: [
      { title: 'Enforce the per-task limit', detail: 'Reject a reward above the owner-configured per-task limit.' },
      { title: 'Enforce the daily budget', detail: 'Count committed spending and reject requests that exceed the daily budget.' },
      { title: 'Reject unauthorized requests', detail: 'Test unauthorized callers and exact-limit boundary cases.' },
    ],
  },
  custom: { label: 'Start from scratch', icon: 'code', title: '', description: '', checkName: '', criteria: [{ title: '', detail: '' }] },
};

export function freshDraft(template = 'near') {
  const chosen = templates[template] || templates.near;
  return {
    paymentRail: 'bank', template: templates[template] ? template : 'near', repository: '', title: chosen.title,
    description: chosen.description, criteria: chosen.criteria.map(c => ({ ...c })),
    amount: '100', branch: '', checkName: '', checkAppId: '15368',
    workflowPath: '', protectedPaths: '', id: null, code: null,
    // Delivery: 'open' (first qualifying merged PR, no deadline) or 'fixed' (exclusive assignment).
    delivery: 'open', deliveryValue: '48', deliveryUnit: 'hours',
  };
}
/** Canonical API duration is an integer number of hours, from 1 hour to 90 days. */
export function deliveryHours(draft) {
  const text = String(draft.deliveryValue ?? draft.deliveryDays ?? '').trim();
  const unit = draft.deliveryUnit || (draft.deliveryDays != null ? 'days' : 'hours');
  const raw = Number(text) * (unit === 'days' ? 24 : 1);
  const hours = Math.round(raw);
  if (!/^(?:\d+)(?:\.\d+)?$/.test(text) || !Number.isFinite(raw) || Math.abs(raw - hours) > 1e-7 || hours < 1 || hours > 2160)
    throw new Error('Choose a delivery window of 1–2,160 whole hours (up to 90 days).');
  return hours;
}
export function deliveryLabel(draft) {
  if (draft.delivery !== 'fixed') return 'No deadline';
  try {
    const hours = deliveryHours(draft);
    return draft.deliveryUnit === 'days' && hours % 24 === 0 ? `${hours / 24} day${hours === 24 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
  } catch { return 'Set a delivery window'; }
}
export function changeDeliveryUnit(draft, unit) {
  if (!['hours', 'days'].includes(unit)) throw new Error('Invalid delivery unit.');
  const hours = deliveryHours(draft);
  return { ...draft, deliveryUnit: unit, deliveryValue: String(unit === 'days' ? Number((hours / 24).toFixed(10)) : hours) };
}

export function hydrateDraft(input) {
  const draft = freshDraft(input?.template);
  if (!input || typeof input !== 'object') return draft;
  for (const field of ['repository', 'title', 'description', 'amount', 'branch', 'checkName', 'checkAppId', 'workflowPath', 'protectedPaths']) {
    if (typeof input[field] === 'string') draft[field] = input[field].slice(0, field === 'description' ? 12000 : 4000);
  }
  if (input.paymentRail === 'base-usdc') draft.paymentRail = 'base-usdc';
  // Server drafts carry versioned terms; browser drafts carry the form fields.
  const terms = input.marketTerms;
  if (terms?.kind === 'fixed' && Number.isSafeInteger(terms.deliveryHours)) {
    draft.delivery = 'fixed'; draft.deliveryValue = String(terms.deliveryHours); draft.deliveryUnit = 'hours';
  } else {
    if (input.delivery === 'fixed') draft.delivery = 'fixed';
    if (typeof input.deliveryValue === 'string') {
      draft.deliveryValue = input.deliveryValue.slice(0, 30);
      draft.deliveryUnit = input.deliveryUnit === 'days' ? 'days' : 'hours';
    } else if (input.deliveryDays != null) {
      draft.deliveryValue = String(input.deliveryDays).slice(0, 30); draft.deliveryUnit = 'days';
    }
  }
  if (Array.isArray(input.criteria) && input.criteria.length) draft.criteria = input.criteria.slice(0, 20).map(c => ({ title: String(c?.title || '').slice(0, 200), detail: String(c?.detail || '').slice(0, 1000) }));
  if (/^[a-f0-9-]{36}$/.test(input.id || '')) draft.id = input.id;
  if (/^NP-[A-F0-9]{10}$/.test(input.code || '')) draft.code = input.code;
  return draft;
}

export function euroCents(value) {
  const text = String(value).trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error('Use an amount with up to two decimal places.');
  const [whole, decimal = ''] = text.split('.');
  const amount = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (amount < 1n || amount > 100000n) throw new Error('Choose a sandbox reward between 0.01 and 1,000.');
  return Number(amount);
}

export function briefErrors(draft) {
  const errors = {};
  if (!draft.title.trim() || draft.title.trim().length > 160) errors.title = 'Give the bounty a title of 1–160 characters.';
  if (!draft.description.trim() || draft.description.length > 12000) errors.description = 'Describe the expected outcome, using up to 12,000 characters.';
  if (!draft.criteria.length || draft.criteria.length > 20 || draft.criteria.some(c => !c.title.trim())) errors.criteria = 'Add 1–20 criteria, each with a clear title.';
  if (criteriaText(draft).length > 4000) errors.criteria = 'Keep the combined acceptance criteria under 4,000 characters.';
  return errors;
}

export function criteriaText(draft) {
  return draft.criteria.map(c => `${c.title.trim()}${c.detail.trim() ? ': ' + c.detail.trim() : ''}`).join('\n');
}

export function draftPayload(draft) {
  const errors = briefErrors(draft);
  if (Object.keys(errors).length) throw new Error(Object.values(errors)[0]);
  if (!/^[\w.-]+\/[\w.-]+$/.test(draft.repository)) throw new Error('Choose a repository you can write to.');
  if (!draft.branch.trim()) throw new Error('Set the target branch in Advanced options.');
  if (!draft.workflowPath.startsWith('.github/workflows/') || !/\.ya?ml$/.test(draft.workflowPath)) throw new Error('Choose an existing GitHub Actions workflow.');
  if (!draft.checkName.trim()) throw new Error('Enter the required job/check name from that workflow.');
  const checkAppId = 15368;
  const protectedPaths = [...new Set([draft.workflowPath, ...draft.protectedPaths.split(/[\n,]+/).map(path => path.trim()).filter(Boolean)])].join('\n');
  if (protectedPaths.length > 4000) throw new Error('Too many protected paths. Remove some additional files.');
  return {
    repository: draft.repository, title: draft.title.trim(), description: draft.description.trim(),
    criteria: criteriaText(draft), amountCents: euroCents(draft.amount), branch: draft.branch.trim(),
    checkName: draft.checkName.trim(), checkAppId, workflowPath: draft.workflowPath,
    protectedPaths,
    ...(draft.paymentRail === "base-usdc" ? {paymentRail:"base-usdc"} : {}),
    ...(draft.delivery === 'fixed' ? { marketTerms: { kind: 'fixed', deliveryHours: deliveryHours(draft) } } : {}),
  };
}

// A browser draft may outlive its server-side editing window. Preserve the
// user's current inputs, but never reuse a published/accepted bounty identity.
export function reconcileDraftIdentity(draft, bounty, userId) {
  if (!draft.id) return { draft, detached: false };
  if (!bounty || bounty.id !== draft.id) throw new Error('The saved bounty could not be verified. Retry before saving.');
  const editable = bounty.ownerId === userId && bounty.status === 'Draft' && !bounty.taskId && !bounty.published;
  return editable ? { draft, detached: false } : { draft: { ...draft, id: null, code: null }, detached: true };
}
