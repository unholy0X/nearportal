import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceProxy } from '../workspace-proxy.mjs';

test('workspace HTML stays on the app origin and forwards its existing session', async()=>{
 let seen;
 const proxy=createWorkspaceProxy({appOrigin:'http://127.0.0.1:8787',frontendOrigin:'http://127.0.0.1:8791',fetcher:async(url,opts)=>{seen={url,opts};return new Response('<main>Settings</main>',{headers:{'Content-Type':'text/html'}})}});
 const res={writeHead(status,headers){this.status=status;this.headers=headers},end(body){this.body=body}};
 assert.equal(await proxy({method:'GET',url:'/app/settings?payout=1',headers:{cookie:'np_session=existing'}},res),true);
 assert.equal(res.status,200);assert.equal(seen.url.origin,'http://127.0.0.1:8787');assert.equal(seen.opts.headers.Cookie,'np_session=existing');assert.equal(res.headers['Cache-Control'],'no-store');
});

test('workspace adapter cannot proxy mutations, APIs, unknown pages or arbitrary files',async()=>{
 let calls=0;const proxy=createWorkspaceProxy({appOrigin:'http://127.0.0.1:8787',frontendOrigin:'http://127.0.0.1:8791',fetcher:()=>{calls++}});
 for(const [method,url] of [['POST','/app/settings'],['GET','/api/portal/me'],['GET','/data/private.json'],['GET','/app/admin'],['GET','/assets/secret.json']])assert.equal(await proxy({method,url,headers:{}},{}),false);
 assert.equal(calls,0);
});
