import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

test('both v2 rails boot with distinct verifiers and immutable per-creator bank refunds', async t => {
  const previous = { ...process.env }, originalFetch = globalThis.fetch;
  const dir = mkdtempSync(join(tmpdir(), 'np-both-rails-')), keys = join(dir, 'keys');
  mkdirSync(keys);
  const bank = 'escrow.bank.fixture.testnet', usdc = 'escrow.usdc.fixture.testnet';
  const ids = { owner: 'owner.bank.fixture.testnet', client: 'client.bank.fixture.testnet',
    verifier: 'verifier.bank.fixture.testnet', relayer: 'relayer.bank.fixture.testnet' };
  process.env = { PATH: previous.PATH, ENV_FILE: '/dev/null', DATA_DIR: dir, NEAR_CREDENTIALS_DIR: keys,
    TASK_PAYMENT_MODE: 'sandbox', TASK_GITHUB_MODE: 'live', TASK_BANK_ENABLED: '1',
    ESCROW_CONTRACT_ID: bank, OWNER_ACCOUNT_ID: ids.owner, CLIENT_ACCOUNT_ID: ids.client,
    GITHUB_VERIFIER_ACCOUNT_ID: ids.verifier, RELAYER_ACCOUNT_ID: ids.relayer,
    MONERIUM_CLIENT_ID: 'fixture-client', MONERIUM_CLIENT_SECRET: 'fixture-secret',
    TASK_CLIENT_IBAN: 'DE89370400440532013000', CRYPTO_USDC_ENABLED: '1',
    CRYPTO_ESCROW_CONTRACT_ID: usdc, CRYPTO_CLIENT_ACCOUNT_ID: 'client.usdc.fixture.testnet',
    CRYPTO_VERIFIER_ACCOUNT_ID: 'verifier.usdc.fixture.testnet', CRYPTO_RELAYER_ACCOUNT_ID: 'relayer.usdc.fixture.testnet',
    PORTAL_OPEN_BOUNTY_ENABLED: '1', MARKET_VERIFIED_CODE_HASHES: 'bank-v2-hash,usdc-v2-hash',
    NEAR_RPC: 'https://rpc.fixture.invalid', PORTAL_ENCRYPTION_KEY: randomBytes(32).toString('base64'), GITHUB_USE_CLI: '0' };
  const { KeyPair } = await import('near-api-js');
  for (const id of [ids.client, ids.verifier, ids.relayer])
    writeFileSync(join(keys, id + '.json'), JSON.stringify({ private_key: KeyPair.fromRandom('ed25519').toString() }), { mode: 0o600 });
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === '127.0.0.1') return originalFetch(input, init);
    assert.equal(url.origin, 'https://rpc.fixture.invalid');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.method, 'query', 'startup and publication cannot send chain transactions');
    const p = body.params, isBank = p.account_id === bank;
    assert.ok(isBank || p.account_id === usdc);
    let result: unknown;
    if (p.request_type === 'view_account') result = { code_hash: isBank ? 'bank-v2-hash' : 'usdc-v2-hash' };
    else {
      methods.push(p.method_name);
      assert.ok(['get_config', 'get_bounty'].includes(p.method_name), 'only the v2 contract ABI');
      const config = isBank ? { ...ids, operators: [ids.client], max_reward_cents: '100000', paused: false }
        : { operators: [process.env.CRYPTO_CLIENT_ACCOUNT_ID], verifier: process.env.CRYPTO_VERIFIER_ACCOUNT_ID, relayer: process.env.CRYPTO_RELAYER_ACCOUNT_ID };
      result = { result: [...Buffer.from(JSON.stringify(p.method_name === 'get_config' ? config : null))], logs: [], block_height: 1, block_hash: '11111111111111111111111111111111' };
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, result });
  };
  t.after(() => { process.env = previous; globalThis.fetch = originalFetch; rmSync(dir, { recursive: true, force: true }); });
  const { taskRuntime } = await import('../server/tasks/http.ts');
  const { portalRuntime } = await import('../server/portal/http.ts');
  const { GitHub } = await import('../server/tasks/github.ts');
  const { bankRefundFor } = await import('../server/tasks/payout.ts');
  const { service } = await taskRuntime();
  t.after(() => service.store.close());
  const github = new GitHub({ token: 'fixture' }, async () => Response.json({ id: 100, full_name: 'owner/test', private: false,
    default_branch: 'main', permissions: { push: true } }));
  const runtime = await portalRuntime(service, { githubFor: () => github });
  const server = createServer((req, res) => void runtime.handler(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const me = await (await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/portal/me`)).json() as any;
  assert.equal(me.openBountyReady, true);
  assert.equal(me.cryptoPaymentsReady, true);
  assert.deepEqual(me.bountyModeCapabilities.fixedDeadlineRails, { bank: true, 'base-usdc': true });
  assert.ok(methods.includes('get_bounty'));

  // GitHub is a fixture; neither chain writes nor provider orders are used below.
  service.config.githubMode = 'fixture';
  const owner = { id: 300, login: 'owner', name: 'Owner', avatar: '', token: 'fixture', createdAt: '',
    bank: { clientId: 'creator-fixture', clientSecret: 'creator-secret' } };
  runtime.store.saveUser(owner);
  const draft = { title: 'Bank v2', description: 'Fixture', criteria: 'Tests pass', repository: 'owner/test', amountCents: 1 };
  const b = runtime.store.bounty((await runtime.portal.create(owner, draft)).id);
  assert.throws(() => runtime.portal.publish(owner, b), /refund bank details/);
  const refund = { firstName: 'Creator', lastName: 'One', iban: 'FR1420041010050500013M02606', country: 'FR' };
  runtime.portal.savePayout(owner, refund);
  runtime.portal.publish(owner, b);
  assert.equal('bankRefund' in runtime.portal.public(b, owner), false, 'encrypted refund is private too');
  runtime.portal.savePayout(owner, { ...refund, iban: 'DE89370400440532013000', country: 'DE' });
  await runtime.portal.tick();
  const task = runtime.portal.task(runtime.store.bounty(b.id))!;
  assert.ok(task, runtime.store.bounty(b.id).error ?? 'task must be prepared');
  assert.equal(bankRefundFor(task).iban, refund.iban, 'settings edits cannot replace a published refund');
  assert.equal(task.policy.verifier, ids.verifier);
  assert.equal(JSON.stringify(service.public(task)).includes(refund.iban), false);
  assert.equal(JSON.stringify(runtime.portal.public(runtime.store.bounty(b.id), owner)).includes(refund.iban), false);
  assert.throws(() => bankRefundFor({ ...task, bankRefund: { ...task.bankRefund!, iban: 'DE89370400440532013000' } }), /refund destination/);
  const funded = service.store.get(task.id); funded.funded = true; service.store.save(funded);
  assert.throws(() => service.claim(funded, { id: 200, login: 'developer' }, refund, funded.policyHash), /distinct/);
  const crypto = await service.create({ ...draft, paymentRail: 'base-usdc', refundAddress: '0x' + 'c1ea2'.repeat(8) }, { ownerId: owner.id, openBounty: true });
  assert.equal(crypto.task.policy.verifier, 'verifier.usdc.fixture.testnet', 'bank activation must not redirect USDC verification');
});
