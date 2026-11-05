// NearPortal workspace shell — canonical source: apps/site/workspace-shell.mjs.
// Copied byte-for-byte into apps/server/src/workspace by `npm run sync:workspace`.
// One header for every workspace route, rendered by the same code in both frontends.

const PATHS = {
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
  external: '<path d="M7 17 17 7M8 7h9v9"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/>',
  coins: '<ellipse cx="9" cy="6" rx="6" ry="3"/><path d="M3 6v8c0 4 12 4 12 0V6M3 10c0 4 12 4 12 0m0-4c6-1 6 4 6 6v4c0 3-6 4-10 2"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  code: '<path d="m8 7-5 5 5 5m8-10 5 5-5 5"/>',
  pr: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17V9a3 3 0 0 0-3-3h-4m2-2-2 2 2 2"/>',
  arrows: '<path d="M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4"/>',
  alert: '<path d="M12 3 2 20h20L12 3Z"/><path d="M12 10v4m0 3h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gavel: '<path d="m14 4 6 6m-9-3 6 6M3 21l8-8m1.5-7.5 6 6-3 3-6-6 3-3Z"/>',
  refresh: '<path d="M20 8a8 8 0 1 0 0 8m0-13v5h-5"/>',
  repo: '<path d="M5 4a1 1 0 0 1 1-1h13v15H6a1 1 0 0 0-1 1V4Zm0 15a2 2 0 0 0 2 2h12v-3"/>',
  wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/>',
  logout: '<path d="M9 4H5v16h4m6-12 4 4-4 4m-8-4h12"/>',
  pencil: '<path d="m15 4 5 5M4 20l5-1L20 8a2 2 0 0 0 0-3l-1-1a2 2 0 0 0-3 0L5 15l-1 5Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  github: '<path fill="currentColor" stroke="none" d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.86c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.89 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.64-1.33-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.99 1.03-2.69-.1-.25-.45-1.28.1-2.66 0 0 .84-.27 2.75 1.03A9.6 9.6 0 0 1 12 6.83a9.6 9.6 0 0 1 2.5.34c1.91-1.3 2.75-1.03 2.75-1.03.55 1.38.2 2.41.1 2.66.64.7 1.03 1.6 1.03 2.69 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.86v2.73c0 .27.18.58.69.48A10 10 0 0 0 12 2Z"/>',
};

export const ICON_NAMES = Object.keys(PATHS);
export function iconPath(name) { return PATHS[name] || ''; }
export function iconMarkup(name) {
  return `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;
}
export function icon(name) {
  const t = document.createElement('template'); t.innerHTML = iconMarkup(name); return t.content.firstElementChild;
}

export const NAV = Object.freeze([
  { href: '/app', label: 'Home' },
  { href: '/bounties', label: 'Find bounties' },
  { href: '/app/work', label: 'My contributions' },
  { href: '/app/bounties', label: 'My bounties' },
]);

/** Which nav entry owns a path. Detail pages belong to the list the person came from. */
export function activeNav(path, { role } = {}) {
  if (path === '/app/leaderboard') return '/app';
  if (path.startsWith('/bounties/')) return role === 'developer' ? '/app/work' : role === 'client' ? '/app/bounties' : '/bounties';
  if (path === '/app/new') return '/app/bounties';
  return NAV.find(item => item.href === path)?.href || '';
}

const esc = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Render the workspace header into `host` (a <header> or empty element) and return a controller.
 * options: { path, role, brandSrc, homeHref }
 */
export function mountShell(host, { path = location.pathname, role, brandSrc = '/brand/guide.png', homeHref = '/app' } = {}) {
  const current = activeNav(path, { role });
  host.className = 'ui-header';
  host.innerHTML = `<div class="ui-header-inner">
<a class="ui-brand" href="${esc(homeHref)}" aria-label="NearPortal workspace"><img src="${esc(brandSrc)}" width="36" height="36" alt=""><span>nearportal</span></a>
<nav class="ui-nav" aria-label="Workspace">${NAV.map(item => `<a href="${item.href}"${item.href === current ? ' aria-current="page"' : ''}>${item.label}</a>`).join('')}</nav>
<div class="ui-header-end">
<span class="ui-env" data-shell="env" hidden title="Sandbox environment: NEAR testnet and Monerium sandbox. No real funds move.">${iconMarkup('info')}<span>Sandbox</span></span>
<a class="ui-button ui-button-secondary ui-button-small" data-shell="login" href="/login" hidden>${iconMarkup('github')}<span>Sign in</span></a>
<div class="ui-profile" data-shell="profile" hidden>
<button class="ui-profile-button" type="button" aria-expanded="false" aria-haspopup="true" data-shell="profile-button"><span class="ui-avatar" data-shell="avatar">${iconMarkup('person')}</span><span class="ui-profile-name" data-shell="name">Account</span>${iconMarkup('chevron')}</button>
<div class="ui-menu" data-shell="menu" hidden>
<p class="ui-menu-state" data-shell="state"></p>
<a href="/app/settings">${iconMarkup('gear')}Settings &amp; payout details</a>
<a href="/app/treasury" data-shell="treasury" hidden>${iconMarkup('wallet')}Demo wallet</a>
<a href="/demo">${iconMarkup('code')}Judge quickstart</a>
<button type="button" data-shell="logout">${iconMarkup('logout')}Sign out</button>
</div></div></div></div>`;
  const q = name => host.querySelector(`[data-shell="${name}"]`);
  const button = q('profile-button'), menu = q('menu');
  let me = null;
  const close = (focus = false) => { if (menu.hidden) return; menu.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
  button.addEventListener('click', () => { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); });
  const onDocClick = event => { if (!host.contains(event.target)) close(); };
  const onKey = event => { if (event.key === 'Escape') close(true); };
  const onFocus = event => { if (!host.contains(event.target)) close(); };
  document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey); document.addEventListener('focusin', onFocus);
  q('logout').addEventListener('click', async () => {
    const control = q('logout'); control.disabled = true;
    try {
      const res = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me?.csrf || '' }, body: '{}' });
      if (!res.ok && res.status !== 204) throw new Error();
      location.assign('/login');
    } catch { control.disabled = false; q('state').textContent = 'Sign-out failed. Try again from Settings.'; }
  });
  // Scroll the active item into view on narrow screens without moving the page.
  const active = host.querySelector('.ui-nav [aria-current]');
  if (active) requestAnimationFrame(() => { const nav = active.parentElement; if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = active.offsetLeft - 16; });
  return {
    setMe(next) {
      me = next; const user = next?.user;
      q('profile').hidden = !user; q('login').hidden = Boolean(user) || !next || path === '/login';
      q('env').hidden = true;
      q('env').querySelector('span').textContent = next?.mode === 'simulation' ? 'Simulation' : 'Sandbox';
      if (!user) return;
      q('name').textContent = '@' + user.login;
      button.setAttribute('aria-label', `Account menu for @${user.login}`);
      q('state').textContent = user.local ? 'Local GitHub preview' : 'GitHub connected';
      q('treasury').hidden = !next.demoTreasuryAvailable;
      const avatar = q('avatar');
      if (user.avatar && /^https:\/\/avatars\.githubusercontent\.com\//.test(user.avatar)) {
        const img = document.createElement('img'); img.src = user.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer'; avatar.replaceChildren(img);
      }
    },
    setActive(nextPath, nextRole) {
      const href = activeNav(nextPath, { role: nextRole });
      for (const a of host.querySelectorAll('.ui-nav a')) { if (a.getAttribute('href') === href) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    },
    destroy() { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey); document.removeEventListener('focusin', onFocus); host.replaceChildren(); },
  };
}

/**
 * Background refresh for workspace pages. Never overlaps itself, pauses while the tab is hidden,
 * spreads requests with ±20% jitter (no synchronized waves across visitors) and backs off
 * exponentially after failures. `run` returns false (or throws) to report a failure.
 */
export function poll(run, { interval = 15000, max = 300000, jitter = 0.2, focus = true } = {}) {
  let timer = 0, running = false, failures = 0, last = Date.now(), stopped = false;
  const delay = () => {
    const base = failures ? Math.min(max, interval * 2 ** failures) : interval;
    return Math.round(base * (1 - jitter + Math.random() * 2 * jitter));
  };
  const schedule = () => { clearTimeout(timer); if (!stopped && !document.hidden) timer = setTimeout(tick, delay()); };
  async function tick() {
    if (running || stopped) return;
    running = true; clearTimeout(timer);
    try { failures = (await run()) === false ? failures + 1 : 0; } catch { failures++; }
    finally { running = false; last = Date.now(); schedule(); }
  }
  // Returning to the tab refreshes once if the data is older than the interval (never a burst).
  const wake = () => { if (document.hidden) { clearTimeout(timer); return; } if (Date.now() - last >= interval) tick(); else schedule(); };
  document.addEventListener('visibilitychange', wake);
  if (focus) window.addEventListener('focus', wake);
  schedule();
  return {
    now: tick,
    get failures() { return failures; },
    stop() { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', wake); window.removeEventListener('focus', wake); },
  };
}
