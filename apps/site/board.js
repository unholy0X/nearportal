import { deadlineIndicator } from '/deadline.mjs';
import { COLUMNS, bountyStatus, columnFor, nextAction, scopeBounties, filterBounties, summary, money, pullRequestUrl } from '/workspace-model.mjs';
import { mountShell, icon, poll } from '/workspace-shell.mjs';

// One page, two roles: /app/bounties (client) and /app/work (developer). Same components, different data and actions.
const role = location.pathname === '/app/work' ? 'developer' : 'client';
const copy = role === 'developer'
  ? { title: 'Contributions', action: 'Find a bounty', actionHref: '/bounties', actionIcon: 'search', noun: 'contributions', empty: 'No contributions yet.', emptyAction: ['Find a bounty', '/bounties'], signedOut: 'Sign in to see the bounties you work on.', search: 'Search contributions' }
  : { title: 'My bounties', action: 'New bounty', actionHref: '/app/new', actionIcon: 'plus', noun: 'bounties', empty: 'No bounties yet.', emptyAction: ['New bounty', '/app/new'], signedOut: 'Sign in to see the bounties you created.', search: 'Search bounties' };
const $ = selector => document.querySelector(selector);
const params = new URLSearchParams(location.search);
const state = { me: null, user: null, items: [], query: params.get('q') || '', repository: params.get('repository') || '', view: params.get('view') === 'list' ? 'list' : 'board', column: params.get('column') || '', loading: true, busy: false, failed: false, last: '', lastUser: undefined };
const shell = mountShell($('#app-header'), { path: location.pathname, brandSrc: '/public/brand/guide.png' });
const options = () => ({ capabilities: state.me?.bountyModeCapabilities });

function el(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function link(text, href, cls) { const n = el('a', cls, text); n.href = href; return n; }
async function api(path) { const res = await fetch('/api/portal' + path, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } }); const data = await res.json(); if (!res.ok) throw new Error(data.error || 'Could not load bounties.'); return data; }

function statusNode(b) { const s = bountyStatus(b, options()), n = el('span', 'ui-status ui-status-' + s.tone); n.append(icon(s.icon), document.createTextNode(s.label)); return n; }
function actionNode(b, cls = 'ui-link ui-card-action') {
  const a = nextAction(b, role, options()), n = link('', a.href, cls);
  n.append(el('span', '', a.label), icon(a.external ? 'external' : 'arrow'));
  if (a.external) { n.target = '_blank'; n.rel = 'noopener noreferrer'; }
  n.setAttribute('aria-label', `${a.label}: ${b.title}${a.external ? ' (opens GitHub)' : ''}`);
  return n;
}
function assignedToMe(b) { return Boolean(state.user?.id && b.task?.policy?.developerId === state.user.id); }
function assignmentNode(b, paid = false) { const n=el('span','ui-assignment'+(paid?' is-paid':'')); n.append(icon(paid?'check':'person'),document.createTextNode(paid?'Paid to you':'Assigned to you')); return n; }
function privateNode() { const p = el('span', 'ui-private'); p.append(icon('lock'), document.createTextNode('Private')); return p; }
// Fixed card anatomy: status row, repository, title (2 lines max), detail, reward + next step at the bottom.
function card(b) {
  const s = bountyStatus(b, options()), n = el('article', 'ui-card');
  n.dataset.status=s.key; const mine=assignedToMe(b); if(mine && s.key!=='paid')n.classList.add('ui-card-assigned');
  const top = el('div', 'ui-card-top'); top.append(statusNode(b)); if (b.private) top.append(privateNode());
  const repo = el('div', 'ui-card-repo'); repo.append(icon('github'), el('span', '', b.repository));
  const title = el('h3', 'ui-card-title'); title.append(link(b.title, '/bounties/' + b.id)); title.title = b.title;
  const foot = el('div', 'ui-card-foot'); foot.append(el('span', 'ui-amount', money(b.amountCents,b.paymentRail)), actionNode(b));
  n.append(top, repo, title);
  if (mine) { const meta=el('p','ui-card-meta'); meta.append(assignmentNode(b,s.key==='paid')); if(b.task?.prNumber)meta.append(document.createTextNode(' · PR #'+b.task.prNumber)); n.append(meta); }
  else if (s.detail) n.append(el('p', 'ui-card-meta', s.detail));
  const clock=deadlineIndicator(b,true);if(clock)n.append(clock);
  n.append(foot);
  if(role==='developer'&&s.key==='inProgress'){const ready=link('Create PR ↗',pullRequestUrl(b),'ui-link ui-card-pr-ready');ready.target='_blank';ready.rel='noopener noreferrer';ready.setAttribute('aria-label','Create pull request on GitHub: '+b.title);n.append(ready);}
  return n;
}
function updateUrl() { const url = new URL(location.href); for (const [key, value] of [['q', state.query], ['repository', state.repository], ['view', state.view === 'list' ? 'list' : ''], ['column', state.column]]) { if (value) url.searchParams.set(key, value); else url.searchParams.delete(key); } history.replaceState(null, '', url); }
function renderRepositories() { const select = $('#repository-filter'), repos = [...new Set(state.items.map(b => b.repository))].sort(); select.replaceChildren(new Option('All repositories', '')); for (const repo of repos) select.append(new Option(repo, repo)); if (state.repository && !repos.includes(state.repository)) select.append(new Option(state.repository, state.repository)); select.value = state.repository; select.disabled = !state.user; }
function empty(text, action) { const box = $('#empty-state'); box.replaceChildren(el('p', '', text)); if (action) box.append(action); box.hidden = false; }
function renderSummary() {
  const parts = summary(state.items, role, options()), list = $('#summary');
  list.replaceChildren(...parts.map(text => el('li', '', text)));
  list.hidden = !parts.length || state.loading;
}
function render() {
  $('#loading').hidden = !state.loading;
  for (const id of ['#board-view', '#list-view', '#empty-state', '#column-tabs']) $(id).hidden = true;
  $('#load-error').hidden = !state.failed;
  $('#board-button').setAttribute('aria-pressed', String(state.view === 'board')); $('#list-button').setAttribute('aria-pressed', String(state.view === 'list'));
  $('#clear-search').hidden = !state.query;
  $('#toolbar').hidden = !state.loading && !state.items.length;
  $('#primary-action').hidden = !state.loading && !state.user;
  renderSummary();
  if (state.loading) return;
  if (!state.user) { empty(copy.signedOut, link('Sign in with GitHub', '/login', 'ui-button')); $('#toolbar').hidden = true; $('#result-announcement').textContent = copy.signedOut; return; }
  const visible = filterBounties(state.items, state);
  $('#result-announcement').textContent = `${visible.length} ${visible.length === 1 ? copy.noun.replace(/ies$/, 'y').replace(/s$/, '') : copy.noun}${state.repository ? ' in ' + state.repository : ''}${state.query ? ' matching your search' : ''}.`;
  if (!state.items.length && !state.failed) { empty(copy.empty, link(copy.emptyAction[0], copy.emptyAction[1], 'ui-button')); return; }
  if (!visible.length) {
    const clear = el('button', 'ui-button ui-button-secondary', 'Clear filters'); clear.type = 'button';
    clear.addEventListener('click', () => { state.query = ''; state.repository = ''; $('#search').value = ''; $('#repository-filter').value = ''; updateUrl(); render(); });
    empty(state.failed ? 'Bounties unavailable. Retry when the connection is back.' : 'No bounties found.', state.failed ? null : clear); return;
  }
  if (state.view === 'board') renderBoard(visible); else renderList(visible);
}
function renderBoard(visible) {
  const columns = COLUMNS[role], grid = $('#board-view'), tabs = $('#column-tabs');
  const groups = columns.map(column => ({ column, items: visible.filter(b => columnFor(b, role, options()) === column.id) }));
  // Narrow screens show one column at a time; default to the first column with work in it.
  if (!columns.some(c => c.id === state.column)) state.column = '';
  const mobileColumn = state.column || groups.find(g => g.items.length)?.column.id || columns[0].id;
  grid.replaceChildren(); tabs.replaceChildren();
  for (const { column, items } of groups) {
    const section = el('section', 'ui-column'); section.dataset.stage=column.id; section.id = 'column-' + column.id; section.setAttribute('aria-labelledby', 'column-title-' + column.id);
    if (column.id === mobileColumn) section.dataset.active = '';
    const head = el('div', 'ui-column-head'), h = el('h2', '', column.title); h.id = 'column-title-' + column.id;
    const count = el('span', 'ui-count', items.length); count.setAttribute('aria-label', `${items.length} ${items.length === 1 ? 'bounty' : 'bounties'}`);
    head.append(h, count);
    const cards = el('div', 'ui-column-cards');
    if (items.length) items.forEach(b => cards.append(card(b))); else cards.append(el('p', 'ui-column-empty', column.empty));
    section.append(head, cards); grid.append(section);
    const tab = el('button', '', `${column.title} (${items.length})`); tab.type = 'button'; tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(column.id === mobileColumn)); tab.setAttribute('aria-controls', section.id);
    tab.addEventListener('click', () => { state.column = column.id; updateUrl(); render(); tabs.querySelector('[aria-selected="true"]')?.focus(); });
    tabs.append(tab);
  }
  grid.dataset.mobileColumn = mobileColumn; grid.hidden = false; tabs.hidden = false;
}
function renderList(visible) {
  const body = $('#bounty-table-body'); body.replaceChildren();
  for (const b of visible) {
    const s = bountyStatus(b, options()), row = el('tr'), title = el('td');row.dataset.status=s.key;const mine=assignedToMe(b);if(mine&&s.key!=='paid')row.classList.add('ui-row-assigned');
    title.append(link(b.title, '/bounties/' + b.id, 'ui-table-title'), el('span', 'ui-table-sub', [b.repository, b.private ? 'Private' : '', s.detail].filter(Boolean).join(' · ')));
    if(mine)title.append(assignmentNode(b,s.key==='paid'));
    const mobile = el('span', 'ui-table-mobile'); mobile.append(el('span', 'ui-amount', money(b.amountCents,b.paymentRail)), statusNode(b)); title.append(mobile);
    const reward = el('td'); reward.append(el('span', 'ui-amount', money(b.amountCents,b.paymentRail)));
    const status = el('td'); status.append(statusNode(b)); const clock=deadlineIndicator(b,true);if(clock)title.append(clock);
    const action = el('td'); action.append(actionNode(b, 'ui-link'));if(role==='developer'&&s.key==='inProgress'){const ready=link('Create PR ↗',pullRequestUrl(b),'ui-link ui-card-pr-ready');ready.target='_blank';ready.rel='noopener noreferrer';action.append(ready);}
    row.append(title, reward, status, action); body.append(row);
  }
  $('#list-view').hidden = false;
}
// Identity changes rarely: re-read /me at most every two minutes, not on every data refresh.
async function currentMe() {
  if (!state.me || Date.now() - (state.meAt || 0) > 120000) { state.me = await api('/me'); state.meAt = Date.now(); }
  return state.me;
}
// The server filters by role and paginates (100 per page, at most 5 pages for this board).
async function myBounties() {
  const scope = role === 'developer' ? 'work' : 'mine', all = [];
  for (let page = 1, pages = 1; page <= Math.min(pages, 5); page++) {
    const data = await api(`/bounties?scope=${scope}&limit=100&page=${page}`);
    all.push(...data.bounties); pages = data.pages || 1;
  }
  return all;
}
async function load() {
  if (state.busy) return; state.busy = true;
  try {
    const me = await currentMe();
    if (me.user?.id !== state.lastUser) { state.items = []; state.last = ''; state.lastUser = me.user?.id; state.loading = true; }
    state.me = me; state.user = me.user; shell.setMe(me);
    $('#environment').textContent = me.mode === 'simulation' ? 'Simulation · no real funds' : 'Sandbox · NEAR testnet · Monerium sandbox · no real funds';
    const items = scopeBounties(state.user ? await myBounties() : [], state.user, role), signature = JSON.stringify(items);
    const changed = signature !== state.last || state.loading || state.failed;
    state.items = items; state.last = signature; state.failed = false; state.loading = false;
    if (changed) { renderRepositories(); render(); }
    $('#update-status').textContent = 'Updated ' + new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return true;
  } catch (error) { state.failed = true; state.loading = false; $('#load-error-copy').textContent = error.message; $('#update-status').textContent = 'Connection interrupted · retrying'; render(); return false; }
  finally { state.busy = false; $('#retry').disabled = false; }
}

document.title = `${copy.title} — NearPortal`;
$('#page-title').textContent = copy.title;
$('#primary-action').href = copy.actionHref; $('#primary-action').append(icon(copy.actionIcon), el('span', '', copy.action));
$('#board-button').append(icon('board'), el('span', '', 'Board')); $('#list-button').append(icon('list'), el('span', '', 'List'));
$('#search').before(icon('search')); $('#repository-filter').after(icon('chevron')); $('#clear-search').append(icon('close'));
$('#search-label').textContent = copy.search; $('#table-caption').textContent = copy.title;
$('#search').value = state.query;
$('#search').addEventListener('input', event => { state.query = event.target.value; updateUrl(); render(); });
$('#clear-search').addEventListener('click', () => { state.query = ''; $('#search').value = ''; updateUrl(); render(); $('#search').focus(); });
$('#repository-filter').addEventListener('change', event => { state.repository = event.target.value; updateUrl(); render(); });
for (const view of ['board', 'list']) $('#' + view + '-button').addEventListener('click', () => { state.view = view; updateUrl(); render(); });
$('#retry').addEventListener('click', () => { $('#retry').disabled = true; load(); });
await load(); poll(load, { interval: 20000 });
