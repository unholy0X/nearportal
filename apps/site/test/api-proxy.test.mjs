import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createPortalProxy } from '../api-proxy.mjs';

function response() { return { status: 0, writeHead(status) { this.status = status; }, end(body) { this.data = JSON.parse(body); } }; }
function request(path, { origin = 'http://127.0.0.1:8791', body = '{}' } = {}) {
  return Object.assign(Readable.from([body]), { url: path, method: 'POST', headers: { origin, 'content-type': 'application/json', cookie: 'np_session=test-session', 'x-csrf-token': 'test-csrf' } });
}
test('cross-origin callers and direct payment endpoints never reach the upstream', async () => {
  let calls = 0;
  const proxy = createPortalProxy({ appOrigin: 'http://127.0.0.1:8787', frontendOrigin: 'http://127.0.0.1:8791', fetcher: () => { calls++; } });
  let res = response(); await proxy(request('/api/portal/bounties', { origin: 'https://untrusted.example' }), res); assert.equal(res.status, 403);
  res = response(); await proxy(request('/api/portal/bounties/12345678-1234-1234-1234-123456789abc/simulate-fund'), res); assert.equal(res.status, 404);
  assert.equal(calls, 0);
});
test('draft saving preserves session and CSRF while using only the fixed upstream origin', async () => {
  let captured;
  const proxy = createPortalProxy({ appOrigin: 'http://127.0.0.1:8787', frontendOrigin: 'http://127.0.0.1:8791', fetcher: async (url, options) => {
    captured = { url, options }; return new Response(JSON.stringify({ bounty: { id: 'saved' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  } });
  const res = response(); await proxy(request('/api/portal/bounties', { body: '{"title":"receipt"}' }), res);
  assert.equal(res.status, 201); assert.equal(captured.url.origin, 'http://127.0.0.1:8787');
  assert.equal(captured.options.headers.Cookie, 'np_session=test-session'); assert.equal(captured.options.headers['X-CSRF-Token'], 'test-csrf');
  assert.equal(captured.options.headers.Origin, 'http://127.0.0.1:8787');
});
test('oversized draft bodies are rejected before forwarding', async () => {
  let called = false;
  const proxy = createPortalProxy({ appOrigin: 'http://127.0.0.1:8787', frontendOrigin: 'http://127.0.0.1:8791', fetcher: () => { called = true; } });
  const res = response(); await proxy(request('/api/portal/bounties', { body: 'x'.repeat(32769) }), res);
  assert.equal(res.status, 413); assert.equal(called, false);
});

test('bounty actions preserve origin and CSRF protection', async () => {
  let calls = 0;
  const proxy = createPortalProxy({ appOrigin: 'http://127.0.0.1:8787', frontendOrigin: 'http://127.0.0.1:8791', fetcher: async () => { calls++; return new Response('{}', { headers: { 'Content-Type': 'application/json' } }); } });
  const path = '/api/portal/bounties/12345678-1234-1234-1234-123456789abc/publish';
  let res = response(); await proxy(request(path, { origin: 'https://untrusted.example' }), res); assert.equal(res.status, 403);
  const req = request(path); delete req.headers['x-csrf-token']; res = response(); await proxy(req, res); assert.equal(res.status, 403);
  res = response(); await proxy(request(path), res); assert.equal(res.status, 200); assert.equal(calls, 1);
});

test('account settings keep session, CSRF and origin checks', async () => {
 let calls=0; const proxy=createPortalProxy({appOrigin:'http://127.0.0.1:8787',frontendOrigin:'http://127.0.0.1:8791',fetcher:async()=>{calls++;return new Response('{}',{headers:{'Content-Type':'application/json'}})}});
 for(const path of ['/api/portal/payout','/api/portal/bank']){
  const denied=response();await proxy(request(path,{origin:'https://untrusted.example'}),denied);assert.equal(denied.status,403);
  const allowed=response();await proxy(request(path),allowed);assert.equal(allowed.status,200);
 }
 assert.equal(calls,2);
});
