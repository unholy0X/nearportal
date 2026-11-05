import { templates, freshDraft, hydrateDraft, euroCents, briefErrors, draftPayload, reconcileDraftIdentity, deliveryHours, deliveryLabel, changeDeliveryUnit } from '/bounty-model.mjs';
import { mountShell } from '/workspace-shell.mjs';

const $ = selector => document.querySelector(selector);
const shell = mountShell($('#app-header'), { path: location.pathname, brandSrc: '/public/brand/guide.png' });
const state = { draft: freshDraft(), step: 1, me: null, repos: [], nextPage: null, setup: null, setupRequest: 0, checkRequest: 0, filesRequest: 0, suggestedFiles: [], saving: false, editIndex: null, storageKey: 'nearportal:bounty:anonymous:v1', initialized: false };
const money = cents => state.draft.paymentRail === 'base-usdc' ? (cents/100).toFixed(2)+' USDC' : new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
let toastTimer, persistTimer, reconnecting = false, editVersion = 0;
const fieldMap = { title: '#bounty-title', description: '#description', branch: '#branch', checkName: '#check-name', protectedPaths: '#protected-paths' };

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use'); use.setAttribute('href', '#' + name); svg.append(use); return svg;
}
function toast(message) { clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').hidden = false; toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500); }
function showError(message) { $('#error-message').textContent = message; $('#error-banner').hidden = false; $('#error-banner').scrollIntoView({ block: 'nearest' }); }
function clearError() { $('#error-banner').hidden = true; }
$('#dismiss-error').addEventListener('click', clearError);

async function api(path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-CSRF-Token'] = state.me?.csrf || ''; }
  const response = await fetch('/api/portal' + path, { method: body === undefined ? 'GET' : 'POST', headers, credentials: 'same-origin', cache: 'no-store', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'The request could not be completed.'); error.status = response.status; throw error; }
  return data;
}

function persist() {
  clearTimeout(persistTimer);
  try { localStorage.setItem(state.storageKey, JSON.stringify(state.draft)); $('#save-state').textContent = 'Saved on this browser'; }
  catch { $('#save-state').textContent = 'Browser storage unavailable'; }
}
function schedulePersist() { editVersion++; $('#save-state').textContent = 'Unsaved changes'; clearTimeout(persistTimer); persistTimer = setTimeout(persist, 350); }
function restoreLocal() {
  try { const raw = localStorage.getItem(state.storageKey); if (raw) { state.draft = hydrateDraft(JSON.parse(raw)); $('#save-state').textContent = 'Browser draft restored'; return true; } }
  catch { $('#save-state').textContent = 'Could not restore the browser draft'; }
  return false;
}

function syncFields() {
  for (const [field, selector] of Object.entries(fieldMap)) $(selector).value = state.draft[field];
  $('#reward-main').value = state.draft.amount;
  $('#task-id').value = state.draft.code || '';
  $('#template-label').textContent = templates[state.draft.template].label;
  $('#template-icon').setAttribute('href', '#' + templates[state.draft.template].icon);
  renderCriteria(); renderSummary(); renderReview();
}

function renderCriteria() {
  const list = $('#criteria-list'); list.replaceChildren();
  state.draft.criteria.forEach((criterion, index) => {
    const row = document.createElement('li'); row.className = 'criterion-row';
    const number = document.createElement('span'); number.className = 'criterion-number'; number.textContent = String(index + 1);
    const copy = document.createElement('div'); copy.className = 'criterion-copy';
    const title = document.createElement('strong'); title.textContent = criterion.title || 'Untitled criterion';
    const detail = document.createElement('p'); detail.textContent = criterion.detail;
    copy.append(title); if (criterion.detail) copy.append(detail);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'icon-button'; edit.dataset.criterion = String(index); edit.setAttribute('aria-label', `Edit criterion ${index + 1}: ${criterion.title}`); edit.append(icon('pencil'));
    row.append(number, copy, edit); list.append(row);
  });
  $('#add-criterion').disabled = state.draft.criteria.length >= 20;
}

function selectedRepo() { return state.repos.find(repo => repo.fullName === state.draft.repository); }
function renderSummary() {
  const crypto = state.draft.paymentRail === 'base-usdc';
  document.querySelectorAll('[name="payment-rail"]').forEach(input => { input.checked = input.value === state.draft.paymentRail; });
  document.querySelectorAll('[data-money-unit]').forEach(n => n.textContent = crypto ? 'USDC' : 'EUR');
  const repo = selectedRepo();
  $('#repository-privacy').hidden = !repo?.private;
  $('#context-repository').textContent = state.draft.repository || 'Choose a repository';
  $('#context-privacy').hidden = !repo;
  $('#context-privacy span').textContent = repo?.private ? 'Private' : 'Public';
  $('#context-privacy use').setAttribute('href', repo?.private ? '#lock' : '#github');
  let amount = '—';
  try { const cents = euroCents(state.draft.amount); amount = money(cents); $('#summary-value').textContent = new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(cents / 100); }
  catch {
    const entered = String(state.draft.amount).trim().replace(',', '.');
    $('#summary-value').textContent = /^\d+(?:\.\d{1,2})?$/.test(entered) && Number.isFinite(Number(entered)) ? new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(Number(entered)) : '—';
  }
  $('#amount-limit').textContent = `Sandbox limit: 1,000 ${crypto ? 'USDC' : 'EUR'}.`;
  try { euroCents(state.draft.amount); $('#amount-error').hidden = true; $('#reward-main').setAttribute('aria-invalid', 'false'); }
  catch { const invalid = state.draft.amount.trim() !== ''; $('#amount-error').hidden = !invalid; $('#amount-error').textContent = `Enter 0.01–1,000 ${crypto ? 'USDC' : 'EUR'} for this sandbox.`; $('#reward-main').setAttribute('aria-invalid', String(invalid)); }
  $('#summary-network-label').textContent = crypto ? 'Network' : 'Payment';
  $('#summary-network').textContent = crypto ? 'Base Sepolia' : 'Bank · Monerium';
  renderDelivery(amount);
  document.querySelectorAll('[data-amount]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.amount) === Number(state.draft.amount))));
}
function renderDelivery(amount) {
  const fixed = state.draft.delivery === 'fixed', rail = state.draft.paymentRail === 'base-usdc' ? 'base-usdc' : 'bank';
  $('#delivery-open').checked = !fixed; $('#delivery-fixed').checked = fixed;
  $('#delivery-value').value = state.draft.deliveryValue;
  $('#delivery-fields').hidden = !fixed;
  document.querySelectorAll('[data-unit]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.unit === state.draft.deliveryUnit)));
  let hours; try { hours = deliveryHours(state.draft); } catch {}
  document.querySelectorAll('[data-hours]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.hours) === hours)));
  const enabled = Boolean(state.me?.bountyModeCapabilities?.fixedDeadlineRails?.[rail]);
  const note = $('#delivery-unavailable');
  note.hidden = !fixed || enabled;
  note.textContent = 'Deadline funding is not enabled for this payment method yet. You can save a draft.';
  $('#summary-delivery').textContent = deliveryLabel(state.draft);
  $('#summary-assignment').textContent = fixed ? 'Exclusive' : 'Single contributor';
  $('#assignment-hint').textContent = 'One contributor at a time.';
  $('#review-terms').hidden = !fixed;
  $('#terms-price').textContent = `${amount} fixed`;
  $('#terms-delivery').textContent = `${deliveryLabel(state.draft)} for one developer at a time`;
  $('#terms-payment').textContent = rail === 'base-usdc' ? 'USDC on Base Sepolia to the wallet the developer signs for, after the agreed check passes on the submitted commit and you merge it (any GitHub merge method).' : 'Bank transfer (Monerium sandbox) to the developer’s saved account, after the agreed check passes on the submitted commit and you merge it (any GitHub merge method).';
}
function renderReview() {
  $('#review-heading').textContent = state.draft.title || 'Your bounty';
  $('#review-repository').textContent = state.draft.repository || 'Choose a repository before saving';
  $('#review-description').textContent = state.draft.description;
  const list = $('#review-criteria'); list.replaceChildren();
  for (const criterion of state.draft.criteria) {
    const row = document.createElement('li'); const title = document.createElement('strong'); title.textContent = criterion.title;
    const detail = document.createElement('p'); detail.textContent = criterion.detail; row.append(title); if (criterion.detail) row.append(detail); list.append(row);
  }
  const workflow = state.setup?.workflows?.find(item => item.path === state.draft.workflowPath);
  $('#review-check').textContent = workflow ? `${state.draft.checkName || 'Set a check name'} · ${workflow.name}` : 'Choose a verification workflow';
  $('#review-branch').textContent = state.draft.branch ? `Target branch: ${state.draft.branch}` : 'Target branch not set';
}

function setStep(step) {
  step = step === 2 ? 1 : step; state.step = step; clearError();
  document.querySelectorAll('[data-pane]').forEach(panel => { panel.hidden = Number(panel.dataset.pane) !== step; });
  document.querySelectorAll('.step').forEach(button => {
    const index = Number(button.dataset.step); button.classList.toggle('is-active', index === step); button.classList.toggle('is-complete', index < step);
    if (index === step) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  });
  $('#page-heading').textContent = step === 3 ? 'Review bounty' : (state.draft?.id ? 'Edit bounty' : 'New bounty');
  $('#create-main').dataset.step = String(step);
  $('#repository-context').hidden = step === 1;
  $('.repository-row').hidden = step !== 1; $('.repository-help-row').hidden = step !== 1;
  $('#new-bounty-back').hidden = step === 1;
  $('#reward-settings').hidden = step === 3;
  $('#summary-heading').textContent = step === 3 ? 'Summary' : 'Reward';
  $('#review-amount').hidden = step !== 3;
  $('.reward-input').hidden = step === 3; $('.amount-presets').hidden = step === 3; $('#amount-limit').hidden = step === 3;
  $('.summary-facts').hidden = step !== 3;
  $('#amount-error').hidden = true;
  $('#default-actions').append($('.creation-footer'));
  document.querySelectorAll('.step').forEach(button => {
    const number = Number(button.dataset.step), node = button.querySelector('.step-node');
    node.replaceChildren(); if (number < step) node.append(icon('check')); else node.textContent = number === 3 ? '2' : '1';
  });
  $('#next-step span').textContent = step === 1 ? 'Review bounty' : (state.me?.user ? 'Continue to funding' : 'Connect GitHub to continue');
  renderSummary(); renderReview();
}

function validateBrief() {
  const errors = briefErrors(state.draft);
  for (const field of ['title', 'description', 'criteria']) {
    const error = $('#' + field + '-error'); error.hidden = !errors[field]; error.textContent = errors[field] || '';
    if (field !== 'criteria') $(fieldMap[field]).setAttribute('aria-invalid', String(Boolean(errors[field])));
  }
  if (Object.keys(errors).length) {
    if (errors.title) $('#bounty-title').focus(); else if (errors.description) $('#description').focus(); else $('#criteria-heading')?.focus();
    showError(Object.values(errors)[0]); return false;
  }
  return true;
}
function validateConnectedDefinition() {
  if (!state.me?.user) return true;
  if (!state.draft.repository) { showError('Choose a GitHub repository before continuing.'); $('#repository').focus(); return false; }
  if (!state.setup || state.setup.canWrite === false) { showError('Choose an active repository with write access.'); return false; }
  if (!state.draft.workflowPath) { showError('Choose an existing GitHub Actions workflow to verify the criteria.'); $('#workflow').focus(); return false; }
  if (!state.draft.checkName.trim()) { showError('Enter the job/check name reported by that workflow.'); $('#check-name').focus(); return false; }
  if (!state.draft.branch.trim()) {
    $('#advanced-options').open = true; showError('Set the target branch in Advanced options.');
    $('#branch').focus(); return false;
  }
  return true;
}
function validateReward() {
  let valid = true;
  try { euroCents(state.draft.amount); $('#amount-error').hidden = true; $('#reward-main').setAttribute('aria-invalid', 'false'); }
  catch (error) { $('#amount-error').textContent = error.message; $('#amount-error').hidden = false; $('#reward-main').setAttribute('aria-invalid', 'true'); $('#reward-main').focus(); valid = false; }
  try { if (state.draft.delivery === 'fixed') deliveryHours(state.draft); $('#delivery-error').hidden = true; $('#delivery-value').setAttribute('aria-invalid', 'false'); }
  catch (error) { $('#delivery-error').textContent = error.message; $('#delivery-error').hidden = false; $('#delivery-value').setAttribute('aria-invalid', 'true'); if (valid) $('#delivery-value').focus(); valid = false; }
  return valid;
}
function goForward() {
  if (state.saving) return;
  if (state.step === 1) { if (validateBrief() && validateConnectedDefinition() && validateReward()) { setStep(3); $('#page-heading').scrollIntoView({ block: 'start' }); } }
  else saveDraft(true);
}
document.querySelectorAll('[name="payment-rail"]').forEach(input => input.addEventListener('change', event => { state.draft.paymentRail = event.target.value; renderSummary(); schedulePersist(); }));
for (const id of ['delivery-open', 'delivery-fixed']) $('#' + id).addEventListener('change', event => { if (event.target.checked) { state.draft.delivery = event.target.value; renderSummary(); schedulePersist(); } });
$('#delivery-value').addEventListener('input', event => { state.draft.deliveryValue = event.target.value; renderSummary(); schedulePersist(); });
document.querySelectorAll('[data-unit]').forEach(button => button.addEventListener('click', () => {
  try { state.draft = changeDeliveryUnit(state.draft, button.dataset.unit); $('#delivery-error').hidden = true; renderSummary(); schedulePersist(); }
  catch { validateReward(); }
}));
document.querySelectorAll('[data-hours]').forEach(button => button.addEventListener('click', () => {
  const hours = Number(button.dataset.hours); state.draft.deliveryUnit = hours === 168 ? 'days' : 'hours';
  state.draft.deliveryValue = String(hours === 168 ? 7 : hours); $('#delivery-error').hidden = true; renderSummary(); schedulePersist();
}));
$('#new-bounty-back').addEventListener('click', () => setStep(1));
$('#next-step').addEventListener('click', goForward);
$('#bounty-form').addEventListener('submit', event => { event.preventDefault(); goForward(); });
$('#back-step').addEventListener('click', () => { if (state.step > 1) setStep(1); else openTemplates(); });
$('#edit-brief').addEventListener('click', () => setStep(1));
document.querySelectorAll('.step').forEach(button => button.addEventListener('click', () => {
  const next = Number(button.dataset.step);
  if (!next) openTemplates(); else if (next <= state.step) setStep(next);
  else if (validateBrief() && validateConnectedDefinition() && validateReward()) setStep(next);
}));

for (const [field, selector] of Object.entries(fieldMap)) $(selector).addEventListener('input', event => { state.draft[field] = event.target.value; schedulePersist(); });
$('#reward-main').addEventListener('input', event => {
  state.draft.amount = event.target.value; renderSummary(); schedulePersist();
});
document.querySelectorAll('[data-amount]').forEach(button => button.addEventListener('click', () => {
  state.draft.amount = button.dataset.amount; $('#reward-main').value = state.draft.amount;
  renderSummary(); $('#amount-error').hidden = true; schedulePersist();
}));

function editCriterion(index) {
  state.editIndex = index;
  const criterion = state.draft.criteria[index] || { title: '', detail: '' };
  $('#criterion-heading').textContent = index === state.draft.criteria.length ? 'Add a success criterion' : 'Edit success criterion';
  $('#criterion-title').value = criterion.title; $('#criterion-detail').value = criterion.detail;
  $('#remove-criterion').hidden = index >= state.draft.criteria.length || state.draft.criteria.length <= 1;
  $('#criterion-dialog').showModal(); $('#criterion-title').focus();
}
$('#criteria-list').addEventListener('click', event => { const button = event.target.closest('[data-criterion]'); if (button) editCriterion(Number(button.dataset.criterion)); });
$('#add-criterion').addEventListener('click', () => { if (state.draft.criteria.length < 20) editCriterion(state.draft.criteria.length); });
$('#criterion-form').addEventListener('submit', event => {
  event.preventDefault(); const title = $('#criterion-title').value.trim(); if (!title) return;
  const criterion = { title, detail: $('#criterion-detail').value.trim() };
  if (state.editIndex === state.draft.criteria.length) state.draft.criteria.push(criterion); else state.draft.criteria[state.editIndex] = criterion;
  $('#criterion-dialog').close(); renderCriteria(); schedulePersist();
});
$('#remove-criterion').addEventListener('click', () => { if (state.draft.criteria.length > 1) state.draft.criteria.splice(state.editIndex, 1); $('#criterion-dialog').close(); renderCriteria(); schedulePersist(); });

function openTemplates() {
  const options = $('#template-options'); options.replaceChildren();
  const descriptions = { near: 'Escrow, receipts, and verifiable on-chain outcomes.', payments: 'Make a reward’s journey across chains visible.', agents: 'Give agents clear, enforceable spending boundaries.', custom: 'Write your own outcome and acceptance criteria.' };
  for (const [id, template] of Object.entries(templates)) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'template-option' + (id === state.draft.template ? ' is-selected' : '');
    const title = document.createElement('strong'); title.textContent = template.label;
    const description = document.createElement('p'); description.textContent = descriptions[id]; button.append(icon(template.icon), title, description);
    if (id === state.draft.template) { const selected = document.createElement('span'); selected.className = 'template-selected'; selected.append(icon('check')); button.append(selected); }
    button.addEventListener('click', () => {
      const previous = state.draft;
      state.draft = { ...freshDraft(id), repository: previous.repository, paymentRail: previous.paymentRail, delivery: previous.delivery, deliveryValue: previous.deliveryValue, deliveryUnit: previous.deliveryUnit, amount: previous.amount, branch: previous.branch, workflowPath: previous.workflowPath, protectedPaths: previous.protectedPaths, checkAppId: previous.checkAppId, checkName: previous.checkName, id: previous.id, code: previous.code };
      syncFields(); setStep(1); $('#template-dialog').close(); schedulePersist();
    });
    options.append(button);
  }
  $('#template-dialog').showModal();
}
$('#change-template').addEventListener('click', openTemplates);
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));

function renderRepositories() {
  const select = $('#repository'); select.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = state.me?.user ? 'Choose a repository' : 'Connect GitHub to choose a repository'; select.append(placeholder);
  for (const repo of state.repos) { const option = document.createElement('option'); option.value = repo.fullName; option.textContent = repo.fullName; select.append(option); }
  select.disabled = !state.me?.user; select.value = state.draft.repository;
  $('#load-more-repositories').hidden = !state.nextPage;
  $('#repository-help').textContent = state.me?.user ? `${state.repos.length} ${state.repos.length === 1 ? 'repository' : 'repositories'} with write access` : 'Connect your GitHub to load repositories you can write to.';
  renderSummary();
}
async function loadRepositories(page = 1) {
  $('#load-more-repositories').disabled = true;
  try {
    const data = await api('/repositories?page=' + page);
    const repositories = page === 1 ? [] : state.repos;
    const map = new Map(repositories.map(repo => [repo.id, repo]));
    data.repositories.filter(repo => repo.canWrite).forEach(repo => map.set(repo.id, repo));
    state.repos = [...map.values()]; state.nextPage = data.nextPage;
    renderRepositories();
    if (state.draft.repository && !selectedRepo()) $('#repository-help').textContent = 'Saved repository not on this page. Load more or choose another repository.';
  } catch (error) { showError(error.message); $('#repository-help').textContent = 'Could not load repositories. Refresh the connection to retry.'; }
  finally { $('#load-more-repositories').disabled = false; }
}
$('#load-more-repositories').addEventListener('click', () => { if (state.nextPage) loadRepositories(state.nextPage); });

async function loadChecks(preserve = false) {
  $('#protected-workflow').textContent = state.draft.workflowPath || 'Choose a workflow above';
  state.draft.protectedPaths = state.draft.protectedPaths.split(/[\n,]+/).map(path => path.trim()).filter(path => path && path !== state.draft.workflowPath).join('\n');
  $('#protected-paths').value = state.draft.protectedPaths; renderFileSuggestions();
  const request = ++state.checkRequest;
  const hint = $('#check-discovery'), input = $('#check-name'), choice = $('#check-choice');
  const previous = preserve ? state.draft.checkName : '';
  state.draft.checkName = ''; input.value = ''; input.disabled = true;
  $('#check-options').replaceChildren(); choice.replaceChildren(); choice.hidden = true;
  hint.textContent = state.draft.workflowPath ? 'Reading checks from GitHub…' : 'Choose a workflow. We’ll detect its checks from GitHub.';
  if (!state.draft.workflowPath || !state.draft.repository) { input.disabled = false; return; }
  const repository = state.draft.repository, workflow = state.draft.workflowPath;
  try {
    const data = await api('/workflow-checks?repository=' + encodeURIComponent(repository) + '&workflow=' + encodeURIComponent(workflow));
    if (request !== state.checkRequest || repository !== state.draft.repository || workflow !== state.draft.workflowPath) return;
    const names = data.checkNames || [];
    for (const name of names) $('#check-options').append(new Option(name, name));
    if (names.length === 1) {
      state.draft.checkName = names[0];
      hint.textContent = 'Detected automatically from this workflow’s latest reported jobs. Confirm it tests your criteria.';
    } else if (names.length > 1) {
      choice.append(new Option('Choose the check that verifies this task', ''));
      for (const name of names) choice.append(new Option(name, name));
      choice.hidden = false;
      state.draft.checkName = names.includes(previous) ? previous : '';
      choice.value = state.draft.checkName;
      hint.textContent = 'This workflow reports several checks. Choose the one that verifies your acceptance criteria.';
    } else {
      state.draft.checkName = previous;
      hint.textContent = 'No check names available yet. Run this workflow on GitHub, then reselect it, or enter its exact reported job name.';
    }
    input.value = state.draft.checkName; schedulePersist(); renderReview();
  } catch {
    if (request !== state.checkRequest) return;
    state.draft.checkName = previous; input.value = previous;
    hint.textContent = 'Could not read the checks. Reselect the workflow to retry, or enter its exact reported job name.';
  } finally { if (request === state.checkRequest) input.disabled = false; }
}
$('#check-choice').addEventListener('change', event => {
  state.draft.checkName = event.target.value; $('#check-name').value = state.draft.checkName; schedulePersist(); renderReview();
});

function renderFileSuggestions() {
  const list = $('#test-suggestions'); list.replaceChildren();
  const selected = new Set(state.draft.protectedPaths.split(/[\n,]+/).map(path => path.trim()));
  for (const path of state.suggestedFiles) {
    const label = document.createElement('label'), checkbox = document.createElement('input'), name = document.createElement('span');
    checkbox.type = 'checkbox'; checkbox.checked = selected.has(path); name.textContent = path;
    checkbox.addEventListener('change', () => {
      const paths = new Set(state.draft.protectedPaths.split(/[\n,]+/).map(value => value.trim()).filter(Boolean));
      if (checkbox.checked) paths.add(path); else paths.delete(path);
      state.draft.protectedPaths = [...paths].join('\n'); $('#protected-paths').value = state.draft.protectedPaths; schedulePersist();
    });
    label.append(checkbox, name); list.append(label);
  }
}
async function loadFileSuggestions() {
  const request = ++state.filesRequest, status = $('#test-suggestions-status');
  state.suggestedFiles = []; renderFileSuggestions();
  if (!state.draft.repository || !state.draft.branch || !state.me?.user) { status.textContent = 'Choose a repository to find test files.'; return; }
  status.textContent = 'Looking for existing tests in your repository…';
  try {
    const data = await api('/verification-files?repository=' + encodeURIComponent(state.draft.repository) + '&branch=' + encodeURIComponent(state.draft.branch));
    if (request !== state.filesRequest) return;
    state.suggestedFiles = data.suggestions; renderFileSuggestions();
    status.textContent = data.suggestions.length ? 'Suggested test files — select those that verify this bounty.' + (data.truncated ? ' GitHub returned a partial file list; add missing paths in Advanced options.' : '') : 'No test files detected. The workflow is still protected; you can add paths in Advanced options.';
  } catch {
    if (request === state.filesRequest) status.textContent = 'Test suggestions unavailable. The workflow remains protected; add other files in Advanced options if needed.';
  }
}
$('#protected-paths').addEventListener('input', renderFileSuggestions);
$('#branch').addEventListener('change', loadFileSuggestions);

async function loadSetup(keepDraft = false) {
  const request = ++state.setupRequest; state.setup = null; ++state.checkRequest;
  const select = $('#workflow'); select.replaceChildren(new Option(state.draft.repository ? 'Loading workflows…' : 'Choose a repository first', '')); select.disabled = true;
  if (!state.draft.repository || !state.me?.user) return;
  try {
    const setup = await api('/repository-setup?repository=' + encodeURIComponent(state.draft.repository));
    if (request !== state.setupRequest) return;
    state.setup = setup;
    if (!keepDraft || !state.draft.branch) state.draft.branch = setup.defaultBranch;
    $('#branch').value = state.draft.branch;
    select.replaceChildren(new Option(setup.workflows.length ? 'Choose an existing workflow' : 'No workflows found in this repository', ''));
    for (const workflow of setup.workflows) select.append(new Option(workflow.name, workflow.path));
    if (!setup.workflows.some(workflow => workflow.path === state.draft.workflowPath)) state.draft.workflowPath = '';
    select.value = state.draft.workflowPath; select.disabled = !setup.workflows.length;
    if (setup.canWrite === false) showError('Your GitHub account needs write access to create a bounty here.');
    else if (!setup.workflows.length) showError('Add a GitHub Actions workflow that tests your criteria, then refresh this connection.');
    loadFileSuggestions();
    await loadChecks(true);
    renderReview();
  } catch (error) { if (request === state.setupRequest) { select.replaceChildren(new Option('Could not load workflows', '')); showError(error.message); } }
}
$('#repository').addEventListener('change', event => {
  state.draft.repository = event.target.value; state.draft.workflowPath = ''; state.draft.branch = ''; state.draft.checkName = ''; $('#check-name').value = ''; loadChecks();
  ++state.filesRequest; state.suggestedFiles = []; state.draft.protectedPaths = ''; $('#protected-paths').value = ''; renderFileSuggestions();
  clearError(); renderSummary(); schedulePersist(); loadSetup();
});
$('#workflow').addEventListener('change', event => { state.draft.workflowPath = event.target.value; schedulePersist(); loadChecks(); });

function detachSavedIdentity(bounty) {
  const result = reconcileDraftIdentity(state.draft, bounty, state.me.user.id);
  if (!result.detached) return false;
  state.draft = result.draft;
  const url = new URL(location.href); url.searchParams.delete('draft'); history.replaceState(null, '', url);
  persist(); syncFields(); setStep(state.step);
  return true;
}
const staleDraftMessage = 'The previous bounty has already left draft mode. Your current inputs are preserved as a new draft. Save it to create a separate bounty; the existing bounty is unchanged.';

async function saveDraft(openFunding = false) {
  if (state.saving) return;
  clearError();
  if (!state.me?.user) {
    persist();
    if (openFunding) { showError('Connect GitHub before creating this bounty. Your browser draft is saved.'); ($('#connection-notice a') || $('#bounty-title')).focus(); }
    else toast('Saved on this browser. Connect GitHub to save it to your account.');
    return;
  }
  if (!validateBrief() || !validateConnectedDefinition()) { setStep(1); validateBrief(); validateConnectedDefinition(); return; }
  let payload;
  try { payload = draftPayload(state.draft); }
  catch (error) { showError(error.message); return; }
  if (openFunding && !$('#funding-understood').checked) { showError('Confirm that you’ll fund the reward before it opens for claims.'); $('#funding-understood').focus(); return; }
  const savingVersion = editVersion;
  state.saving = true; $('#save-draft').disabled = true; $('#next-step').disabled = true; $('#save-draft').textContent = 'Saving…';
  try {
    if (state.draft.id) {
      const { bounty: current } = await api('/bounties/' + state.draft.id);
      if (detachSavedIdentity(current)) { showError(staleDraftMessage); return; }
    }
    const { bounty } = await api(state.draft.id ? `/bounties/${state.draft.id}/edit` : '/bounties', payload);
    if (!bounty?.id || !/^NP-[A-F0-9]{10}$/.test(bounty.code || '')) throw new Error('The draft save could not be confirmed. Check your existing drafts before retrying.');
    state.draft.id = bounty.id; state.draft.code = bounty.code; $('#task-id').value = bounty.code;
    setStep(state.step);
    persist();
    const changedDuringSave = savingVersion !== editVersion;
    $('#save-state').textContent = changedDuringSave ? 'Draft saved; newer edits on this browser' : 'Draft saved to your account';
    const url = new URL(location.href); url.searchParams.set('draft', bounty.id); history.replaceState(null, '', url);
    if (openFunding && !changedDuringSave) location.assign('/bounties/' + bounty.id);
    else toast(changedDuringSave ? 'Draft saved. Save your newer edits before continuing to funding.' : 'Draft saved. The reward is not funded yet.');
  } catch (error) {
    if (error.status === 401) { showError('Your GitHub session expired. Connect again; your browser draft is preserved.'); }
    else showError(error.message);
  } finally { state.saving = false; $('#save-draft').disabled = false; $('#next-step').disabled = false; $('#save-draft').textContent = 'Save draft'; }
}
$('#save-draft').addEventListener('click', () => saveDraft(false));

function renderConnection() {
  const user = state.me?.user;
  shell.setMe(state.me);
  $('#connection-notice').hidden = Boolean(user);
  if (!user) $('#connection-description').textContent = 'Shape the brief now. Sign in in the new tab, then return here to load your repositories.';
  setStep(state.step);
}

async function connect({ initial = false } = {}) {
  if (reconnecting) return;
  reconnecting = true; $('#refresh-connection').disabled = true;
  try {
    let detached = false;
    const data = await api('/me');
    const changed = data.user?.id !== state.me?.user?.id;
    const anonymousDraft = state.initialized && !state.me?.user && data.user ? hydrateDraft(state.draft) : null;
    state.me = data;
    if (initial || changed) {
      state.storageKey = `nearportal:bounty:${data.user?.id || 'anonymous'}:v1`;
      state.draft = freshDraft();
      const restored = restoreLocal();
      if (!restored && anonymousDraft) { state.draft = anonymousDraft; state.draft.id = null; state.draft.code = null; }
      const params = new URLSearchParams(location.search);
      if (initial && params.get('repository')) state.draft.repository = params.get('repository');
      if (initial && data.user && /^[a-f0-9-]{36}$/.test(params.get('draft') || '')) {
        const { bounty } = await api('/bounties/' + params.get('draft'));
        if (bounty.ownerId !== data.user.id) throw new Error('This bounty belongs to another GitHub account. Open your own drafts from My bounties.');
        if (bounty.status === 'Draft' && !bounty.taskId && !bounty.published) {
          state.draft = hydrateDraft({ ...bounty, template: state.draft.template, paymentRail: bounty.paymentRail || "bank", amount: String(bounty.amountCents / 100), checkAppId: String(bounty.checkAppId), criteria: bounty.criteria.map(title => ({ title, detail: '' })) });
        } else {
          // Preserve current browser inputs rather than replacing them with old funded terms.
          state.draft.id = bounty.id; state.draft.code = bounty.code;
        }
      }
      if (data.user && state.draft.id) {
        const { bounty } = await api('/bounties/' + state.draft.id);
        detached = detachSavedIdentity(bounty);
      }
      syncFields();
    }
    renderConnection();
    if (data.user) { await loadRepositories(); await loadSetup(true); }
    else { state.repos = []; state.nextPage = null; renderRepositories(); $('#workflow').replaceChildren(new Option('Connect GitHub to load workflows', '')); $('#workflow').disabled = true; }
    state.initialized = true;
    if (detached) showError(staleDraftMessage);
  } catch (error) {
    if (!state.initialized) { restoreLocal(); syncFields(); }
    renderConnection(); renderRepositories();
    $('#connection-notice').hidden = false; $('#connection-title').textContent = 'The GitHub connection could not be loaded.';
    $('#connection-description').textContent = 'Your browser draft is available. Use Refresh connection when the existing app is running.';
    showError(error.message);
  } finally { reconnecting = false; $('#refresh-connection').disabled = false; }
}
$('#refresh-connection').addEventListener('click', () => { clearError(); connect(); });
addEventListener('focus', () => { if (state.initialized && !state.me?.user) connect(); });
addEventListener('pagehide', () => { if (state.initialized) persist(); });
syncFields(); connect({ initial: true });
