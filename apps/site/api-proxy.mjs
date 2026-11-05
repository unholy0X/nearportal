const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
};

// Fixed-upstream UI adapter. Session, CSRF and backend role checks remain authoritative.
// Settings use the same authenticated, CSRF-checked endpoints; direct payout and simulated deposit APIs remain unavailable.
export function createPortalProxy({ appOrigin, frontendOrigin, fetcher = fetch }) {
  const backend = new URL(appOrigin);
  return async function portalProxy(req, res) {
    const url = new URL(req.url, frontendOrigin);
    const logout = url.pathname === '/auth/logout';
    if (!url.pathname.startsWith('/api/portal/') && !logout) return false;
    const readAllowed = /^\/api\/portal\/(?:home|leaderboard|treasury|me|judge-demo|repositories|repository-setup|workflow-checks|verification-files|bounties|bounties\/(?:[a-f0-9-]{36}|NP-[A-F0-9]{10})(?:\/deposit)?)$/.test(url.pathname);
    const writeAllowed = logout || /^\/api\/portal\/(?:payout|bank|judge-payout|bounties(?:\/[a-f0-9-]{36}\/(?:treasury-fund|edit|publish|claim|pr|refresh|request-access|check-access|invite|dispute|prepare-judge-pr|wallet-challenge|accept-work|submit|withdraw))?)$/.test(url.pathname);
    const write = req.method === 'POST';
    if (!(req.method === 'GET' && readAllowed) && !(write && writeAllowed)) { json(res, 404, { error: 'Endpoint unavailable in this workspace.' }); return true; }
    if (write && req.headers.origin !== frontendOrigin) { json(res, 403, { error: 'Cross-origin request rejected.' }); return true; }
    if (write && !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) { json(res, 415, { error: 'Send a JSON draft.' }); return true; }
    if (write && (!req.headers['x-csrf-token'] || !req.headers.cookie)) { json(res, 403, { error: 'Sign in again before saving this draft.' }); return true; }
    try {
      let body;
      if (write) {
        const chunks = []; let size = 0;
        for await (const chunk of req) {
          size += Buffer.byteLength(chunk);
          if (size > 32768) { json(res, 413, { error: 'Draft is too large.' }); return true; }
          chunks.push(Buffer.from(chunk));
        }
        body = Buffer.concat(chunks).toString('utf8');
        try { const value = JSON.parse(body); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); }
        catch { json(res, 400, { error: 'Invalid draft data.' }); return true; }
      }
      const headers = { Accept: 'application/json' };
      if (req.headers.cookie) headers.Cookie = req.headers.cookie;
      if (write) {
        headers['Content-Type'] = 'application/json';
        headers['X-CSRF-Token'] = req.headers['x-csrf-token'];
        // Only after checking the actual browser Origin above: canonical origin for the fixed upstream.
        headers.Origin = backend.origin;
      }
      const upstream = await fetcher(new URL(url.pathname + url.search, backend), { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      if (logout && upstream.status === 204) { const cookies = upstream.headers.getSetCookie?.() || []; res.writeHead(204, { 'Cache-Control': 'no-store', ...(cookies.length ? { 'Set-Cookie': cookies } : {}) }); res.end(); return true; }
      if (!upstream.headers.get('content-type')?.includes('application/json')) throw new Error('Invalid upstream response');
      json(res, upstream.status, await upstream.json());
    } catch { json(res, 502, { error: 'The existing NearPortal app is unavailable. Your browser draft is preserved; retry when it is running.' }); }
    return true;
  };
}
