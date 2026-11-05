// Route table for the Aurora landing and the workspace pages it owns. Shared by the local
// preview server (server.mjs) and the hosted backend, so both serve exactly the same pages.
export const SITE_FILES = ['terms.html', 'privacy.html', 'deadline.mjs', 'deadline.css', 'home.html', 'home.css', 'home.js', 'index.html', 'styles.css', 'app.js', 'create.html', 'create.css', 'create.js', 'bounty-model.mjs', 'bounty.html', 'bounty.css', 'bounty.js', 'bounty-detail-model.mjs', 'journey.mjs', 'funding-progress.mjs', 'board.html', 'board.js', 'workspace.css', 'workspace-fonts.css', 'workspace-model.mjs', 'workspace-shell.mjs', 'treasury.html', 'treasury.css', 'treasury.js', 'site.mjs'];
export const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8' };
const DETAIL = /^\/bounties\/(?:[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}|NP-[A-F0-9]{10})$/;
const PAGES = { '/terms': 'terms.html', '/privacy': 'privacy.html', '/': 'index.html', '/app': 'home.html', '/app/leaderboard': 'home.html', '/app/treasury': 'treasury.html', '/app/bounties': 'board.html', '/app/work': 'board.html', '/app/new': 'create.html', '/create': 'create.html', '/create.html': 'create.html' };
/** Routes rendered by the React workspace (served by the backend). */
export const APP_PAGE = /^\/(?:app(?:\/(?:repositories|settings))?|login|bounties|demo)$/;
/**
 * The landing file for a request path: { page } for an HTML route, { file } for an allowlisted
 * asset, or null when the landing does not own the path.
 */
export function siteTarget(pathname) {
  if (Object.hasOwn(PAGES, pathname)) return { page: PAGES[pathname] };
  if (DETAIL.test(pathname)) return { page: 'bounty.html' };
  let name;
  try { name = decodeURIComponent(pathname).slice(1); } catch { return null; }
  if (name.split('/').some(part => !part || part.startsWith('.'))) return null;
  if (SITE_FILES.includes(name) || /^public\/[A-Za-z0-9_\/-]+\.(?:png|jpg|webp|svg|ico|ttf|txt)$/.test(name)) return { file: name };
  return null;
}
