// Container smoke test of the image actually shipped (nearportal:demo) behind the real edge proxy
// (Caddy, HTTPS with a locally issued certificate). Disposable stack: simulation payments, fixture
// GitHub, tmpfs data, no credentials, no traffic to GitHub/RPC/Monerium.
// Usage (from apps/server): node scripts/image-smoke.mjs   (NEARPORTAL_IMAGE overrides the image)
import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const compose = ['compose', '-p', 'npsmoke', '-f', 'deploy/staging/compose.smoke.yaml'];
const env = { ...process.env, SMOKE_KEY: randomBytes(32).toString('base64') };
const docker = (...args) => execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const origin = 'https://nearportal.test';
const results = [];
// A generated link to a loopback origin (copy that merely mentions "localhost" is not a link).
const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/;
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
function curl(path, { method = 'GET', headers = {}, body, raw = false } = {}) {
  const args = ['-sk', '--resolve', 'nearportal.test:8443:127.0.0.1', '-X', method, '-D', '-', '-o', '-', '--max-time', '20'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (body !== undefined) args.push('--data-binary', body);
  args.push(`https://nearportal.test:8443${path}`);
  const out = spawnSync('curl', args, { encoding: raw ? 'buffer' : 'utf8', maxBuffer: 20e6 }).stdout.toString();
  const split = out.search(/\r?\n\r?\n/);
  const head = out.slice(0, split), text = out.slice(split).replace(/^\r?\n\r?\n/, '');
  const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 0);
  const header = name => new RegExp(`^${name}: (.*)$`, 'gim').exec(head)?.[1]?.trim() ?? '';
  const cookies = [...head.matchAll(/^set-cookie: (.*)$/gim)].map(m => m[1].trim());
  return { status, header, cookies, text };
}

try {
  docker(...compose, 'up', '-d', '--wait', '--wait-timeout', '120');
  check('stack starts and the app reports healthy (readiness probe)', true);
  const app = docker(...compose, 'ps', '-q', 'nearportal').trim();
  check('app port 8787 is not published to the host', !docker('port', app).trim(), docker('port', app).trim() || 'no published ports');

  const ready = curl('/api/portal/readyz');
  check('readiness through the HTTPS proxy', ready.status === 200 && JSON.parse(ready.text).ready === true, ready.text.slice(0, 120));
  check('HSTS on the HTTPS origin', /max-age=/.test(curl('/').header('strict-transport-security')));

  const pages = ['/', '/app', '/app/leaderboard', '/bounties', '/app/bounties', '/app/work', '/app/new', '/app/treasury', '/app/repositories', '/app/settings', '/login', '/demo', '/bounties/00000000-0000-4000-8000-000000000000'];
  const assets = new Set();
  let leaked = [];
  for (const page of pages) {
    const r = curl(page);
    const csp = r.header('content-security-policy');
    check(`page ${page}`, r.status === 200 && /text\/html/.test(r.header('content-type')) && /script-src 'self'/.test(csp) && r.header('x-frame-options') === 'DENY', `${r.status} ${r.header('content-type')}`);
    for (const m of r.text.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) if (!/^\/(api|auth)\//.test(m[1]) && !/^\/(app|bounties|login|demo)(\/|$)/.test(m[1])) assets.add(m[1]);
    if (LOCAL_URL.test(r.text)) leaked.push(page);
  }
  let missing = [];
  for (const a of assets) {
    const r = curl(a);
    if (r.status !== 200) missing.push(`${a} → ${r.status}`);
    if (/\.(m?js|css)$/.test(a) && LOCAL_URL.test(r.text)) leaked.push(a);
  }
  check(`all ${assets.size} assets referenced by the pages are served`, !missing.length, missing.join(', '));
  check('no localhost link in served pages or scripts', !leaked.length, leaked.join(', '));

  const oauth = curl('/auth/github?returnTo=/app');
  const location = oauth.header('location');
  const cookie = oauth.cookies.find(c => c.startsWith('np_oauth=')) ?? '';
  check('OAuth start redirects to GitHub with the public HTTPS callback', oauth.status === 302 && location.startsWith('https://github.com/login/oauth/authorize?') && new URL(location).searchParams.get('redirect_uri') === `${origin}/auth/github/callback` && new URL(location).searchParams.get('code_challenge_method') === 'S256', location.slice(0, 140));
  check('OAuth state cookie is Secure, HttpOnly, SameSite=Lax', /; HttpOnly/.test(cookie) && /; Secure/.test(cookie) && /SameSite=Lax/.test(cookie));
  const callback = curl('/auth/github/callback?state=forged&code=x');
  check('forged OAuth callback is refused without contacting GitHub', callback.status === 400 && /expired/.test(callback.text), `${callback.status}`);

  // A signed-in session created inside the container (no GitHub involved) for CSRF checks.
  const token = randomBytes(32).toString('base64url');
  docker('exec', app, 'node', '--import', 'tsx', '-e', `
    const {DatabaseSync}=await import('node:sqlite');const {PortalStore,digest}=await import('/workspace/apps/server/server/portal/store.ts');
    const db=new DatabaseSync('/var/lib/nearportal/github-tasks.sqlite');const s=new PortalStore(db,'/var/lib/nearportal',Buffer.from(process.env.PORTAL_ENCRYPTION_KEY,'base64'));
    s.saveUser({id:4242,login:'smoke',name:'Smoke',avatar:'',token:'unused',createdAt:new Date().toISOString()});
    db.prepare('INSERT INTO portal_sessions VALUES(?,?,?,?)').run(digest('${token}'),4242,'csrf-${token.slice(0, 8)}',Date.now()+3600000);`);
  const session = { Cookie: `np_session=${token}` };
  const me = JSON.parse(curl('/api/portal/me', { headers: session }).text);
  check('session cookie is accepted through the proxy', me.user?.login === 'smoke' && me.csrf);
  const payout = JSON.stringify({ firstName: 'Smoke', lastName: 'Test', iban: 'FR1420041010050500013M02606', country: 'FR' });
  const json = { 'Content-Type': 'application/json' };
  const cross = curl('/api/portal/payout', { method: 'POST', headers: { ...session, ...json, Origin: 'https://evil.example', 'X-CSRF-Token': me.csrf }, body: payout });
  check('cross-origin mutation rejected', cross.status === 403, `${cross.status} ${cross.text.slice(0, 80)}`);
  const noCsrf = curl('/api/portal/payout', { method: 'POST', headers: { ...session, ...json, Origin: origin }, body: payout });
  check('mutation without CSRF token rejected', noCsrf.status === 403, `${noCsrf.status}`);
  const okWrite = curl('/api/portal/payout', { method: 'POST', headers: { ...session, ...json, Origin: origin, 'X-CSRF-Token': me.csrf }, body: payout });
  check('same-origin mutation with CSRF token accepted', okWrite.status === 200 && !okWrite.text.includes('0013M02606'), `${okWrite.status} ${okWrite.text.slice(0, 80)}`);

  // Quotas cannot be dodged by forging X-Forwarded-For: Caddy overwrites it with the real peer.
  const statuses = spawnSync('bash', ['-c', `seq 1 340 | xargs -P 24 -I{} curl -sk -o /dev/null -w '%{http_code}\\n' --resolve nearportal.test:8443:127.0.0.1 -H "X-Forwarded-For: 10.9.{}.1" https://nearportal.test:8443/auth/github`], { encoding: 'utf8' }).stdout.trim().split('\n');
  const limited = statuses.filter(s => s === '429').length;
  check('forged X-Forwarded-For does not bypass the sign-in quota (300/min per real IP)', limited >= 30, `${limited} of ${statuses.length} limited`);
  const limitedResponse = curl('/auth/github');
  check('429 carries Retry-After', limitedResponse.status !== 429 || Number(limitedResponse.header('retry-after')) > 0, limitedResponse.header('retry-after'));

  check('operational metrics are not exposed publicly', curl('/api/ops/metrics').status === 404);
  const internal = docker('exec', app, 'node', '-e', "fetch('http://127.0.0.1:8787/api/ops/metrics',{headers:{Authorization:'Bearer smoke-metrics-token'}}).then(async r=>console.log(r.status,(await r.text()).includes('nodejs_eventloop_lag_p99_ms')))").trim();
  check('metrics available internally with the token', internal === '200 true', internal);

  const ping = JSON.stringify({ zen: 'smoke', repository: { id: 1 } });
  const signature = 'sha256=' + createHmac('sha256', 'smoke-webhook-secret').update(ping).digest('hex');
  const hook = curl('/api/github/webhook', { method: 'POST', headers: { ...json, 'X-Hub-Signature-256': signature, 'X-GitHub-Delivery': 'smoke-1', 'X-GitHub-Event': 'ping' }, body: ping });
  check('signed webhook accepted (durable, deduplicated)', hook.status === 202, hook.text);
  const forged = curl('/api/github/webhook', { method: 'POST', headers: { ...json, 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64), 'X-GitHub-Delivery': 'smoke-2', 'X-GitHub-Event': 'ping' }, body: ping });
  check('forged webhook signature rejected', forged.status === 401);

  const logs = docker(...compose, 'logs', 'nearportal');
  check('no secrets in container logs', !/smoke-client-secret|smoke-metrics-token|smoke-admin-token|FR1420041010050500013M02606|np_session=/.test(logs + docker('inspect', '--format', '{{json .State}}', app)));
  docker(...compose, 'stop', '-t', '45', 'nearportal');
  const stopped = docker(...compose, 'logs', 'nearportal');
  check('graceful shutdown completes cleanly', /"event":"server.stopped","requestId":null,"clean":true|"event":"server.stopped"[^\n]*"clean":true/.test(stopped), (stopped.match(/.*server\.stopped.*/) || [''])[0].slice(0, 160));
} catch (error) {
  check('smoke test ran to completion', false, String(error.stderr || error.message).slice(0, 400));
} finally {
  try { docker(...compose, 'down', '-v', '--remove-orphans'); } catch { /* already down */ }
  const failed = results.filter(r => !r.ok);
  writeFileSync(process.env.SMOKE_RESULTS || 'image-smoke-results.json', JSON.stringify({ image: process.env.NEARPORTAL_IMAGE || 'nearportal:demo', at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}
