import test from 'node:test';
import assert from 'node:assert/strict';
import { Monerium } from '../src/monerium.ts';
import type { Config } from '../src/config.ts';

test('order discovery rejects unrelated wallets and chains even if upstream filtering is broad', async () => {
 const original=globalThis.fetch;
 globalThis.fetch=async (_url,options) => new Response(JSON.stringify(options?.method==='POST' ? {access_token:'test-token',expires_in:3600} : {orders:[
  {id:'correct',address:'0xAbC',chain:'basesepolia'},
  {id:'wrong-wallet',address:'0xdef',chain:'basesepolia'},
  {id:'wrong-chain',address:'0xabc',chain:'ethereum'},
  {id:'missing-wallet',chain:'basesepolia'},
 ]}),{status:200,headers:{'Content-Type':'application/json'}});
 try {
  const m=new Monerium({moneriumApi:'https://sandbox.invalid',moneriumClientId:'test',moneriumClientSecret:'test',chain:'basesepolia'} as Config);
  assert.deepEqual((await m.ordersFor('0xabc')).map(o=>o.id),['correct']);
 } finally {globalThis.fetch=original;}
});
