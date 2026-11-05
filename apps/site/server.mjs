import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createPortalProxy } from './api-proxy.mjs';
import { createWorkspaceProxy } from './workspace-proxy.mjs';
import { siteTarget, TYPES } from './site.mjs';

const directory = fileURLToPath(new URL('./', import.meta.url));
const production = process.argv.includes('--production');
const root = production ? path.join(directory, 'dist') + path.sep : directory;
const port = Number(process.env.PORT || 8791);
const appOrigin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:8787');
if (!['http:', 'https:'].includes(appOrigin.protocol)) throw new Error('APP_ORIGIN must use HTTP or HTTPS');
// The browser-facing origin. Local preview defaults to loopback; a staging proxy sets FRONTEND_ORIGIN.
const frontendOrigin = new URL(process.env.FRONTEND_ORIGIN || `http://127.0.0.1:${port}`).origin;
const portalProxy = createPortalProxy({ appOrigin: appOrigin.origin, frontendOrigin });
const workspaceProxy = createWorkspaceProxy({ appOrigin: appOrigin.origin, frontendOrigin });
const types = TYPES;
const server = http.createServer(async (req, res) => {
  try {
    if (await portalProxy(req, res)) return;
    if (!['/app','/app/leaderboard'].includes(new URL(req.url,frontendOrigin).pathname) && await workspaceProxy(req, res)) return;
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const url = new URL(req.url, 'http://localhost');
    const owned = siteTarget(url.pathname);
    if (!owned && /^\/(?:app(?:\/|$)|auth\/|bounties(?:\/|$)|login(?:\/|$))/.test(url.pathname)) {
      const target = new URL(url.pathname + url.search, appOrigin);
      res.writeHead(302, { Location: target.href, 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (!owned) throw new Error('not found');
    const target = path.resolve(root, './' + (owned.page || owned.file));
    if (!target.startsWith(root) || !(await stat(target)).isFile()) throw new Error('not found');
    let bytes = await readFile(target);
    const headers = { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', Vary: 'Accept-Encoding' };
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && /\.(?:html|css|mjs|js|svg|ttf)$/.test(target)) {
      bytes = gzipSync(bytes); headers['Content-Encoding'] = 'gzip';
    }
    headers['Content-Length'] = bytes.length;
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
});
server.listen(port, '127.0.0.1', () => console.log(`NearPortal landing: http://127.0.0.1:${port}\nProduct links: ${appOrigin.origin}`));
