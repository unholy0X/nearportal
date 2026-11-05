import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PortalStore } from '../server/portal/store.ts';
import { TreasuryCore, InvalidTreasuryReceipt, depositReference, type TreasuryTarget } from '../server/portal/treasury-core.ts';
import { verifyTreasuryLogs, DEMO_TOKEN } from '../server/portal/treasury-evm.ts';
import { acceptsTreasuryFunding, treasuryAllowed } from '../server/portal/treasury.ts';
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from 'viem';
const source = '0x1111111111111111111111111111111111111111';
const target: TreasuryTarget = { bountyId: 'bounty', taskId: 'task', ownerId: 1, jobId: 4, amountCents: 100, policyHash: 'agreed', address: '0x2222222222222222222222222222222222222222' };
function setup() {
    const db = new DatabaseSync(':memory:'), store = new PortalStore(db, '', randomBytes(32));
    const count = { prepare: 0, broadcast: 0, record: 0 }, flags = { broadcastFails: false, recordFails: false, invalid: false, mined: false, balance: 100000, gas: '1' };
    const gateway = { async balance() { return { balanceCents: flags.balance, gasWei: flags.gas }; }, async prepare() { count.prepare++; return { hash: '0x' + 'ab'.repeat(32), raw: 'private-signed-bytes' }; }, async broadcast() { count.broadcast++; if (flags.broadcastFails)
            throw new Error('timeout'); }, async receipt() { if (flags.invalid)
            throw new InvalidTreasuryReceipt('Wrong token'); return flags.mined ? { reference: 'proof' } : null; } };
    const hooks = { async target(id: string, owner: number) { if (owner !== 1)
            throw new Error('Only the operator'); return { ...target, bountyId: id }; }, async record() { count.record++; if (flags.recordFails)
            throw new Error('NEAR timeout'); } };
    const core = new TreasuryCore(store, gateway, hooks);
    return { db, store, count, flags, gateway, hooks, core };
}
test('repeated and concurrent clicks sign and broadcast once; private signed bytes never enter status', async () => {
    const { core, count, db } = setup();
    await Promise.all([core.start('bounty', 1, 'agreed'), core.start('bounty', 1, 'agreed')]);
    assert.equal(count.prepare, 1);
    assert.equal(count.broadcast, 1);
    assert.equal(core.publicIntent('bounty')?.state, 'Pending');
    assert(!JSON.stringify(core.publicIntent('bounty')).includes('private-signed'));
    assert(!String((db.prepare('SELECT body FROM portal_treasury_funding').get() as any).body).includes('private-signed'));
    await assert.rejects(core.start('bounty', 1, 'different'), /changed/);
    await assert.rejects(core.start('bounty', 2, 'agreed'), /changed/);
});
test('a broadcast timeout resumes the same signed transaction after restart', async () => {
    const { core, count, flags, store, gateway, hooks } = setup();
    flags.broadcastFails = true;
    await core.start('bounty', 1, 'agreed');
    flags.broadcastFails = false;
    const restarted = new TreasuryCore(store, gateway, hooks);
    await restarted.reconcile();
    assert.equal(count.prepare, 1);
    assert.equal(count.broadcast, 2);
    assert.equal(count.record, 0);
    flags.mined = true;
    await restarted.reconcile();
    await restarted.reconcile();
    assert.equal(count.record, 1);
    assert.equal(restarted.publicIntent('bounty')?.state, 'Recorded');
});
test('limits, owner, balance and gas are checked before signing', async () => {
    const { core, count, flags } = setup();
    await assert.rejects(core.start('bounty', 2, 'agreed'), /operator/);
    flags.balance = 0;
    await assert.rejects(core.start('bounty', 1, 'agreed'), /Top up/);
    flags.balance = 10000;
    flags.gas = '0';
    await assert.rejects(core.start('bounty', 1, 'agreed'), /ETH/);
    assert.equal(count.prepare, 0);
});
test('unconfirmed or invalid receipts never credit NEAR', async () => {
    const { core, count, flags } = setup();
    await core.start('bounty', 1, 'agreed');
    await core.reconcile();
    assert.equal(count.record, 0);
    flags.invalid = true;
    await core.reconcile();
    assert.equal(count.record, 0);
    assert.equal(core.publicIntent('bounty')?.state, 'Failed');
});
test('per-bounty and daily limits stop funding before signing', async () => {
    const { store, gateway, hooks, count } = setup();
    const perBounty = new TreasuryCore(store, gateway, hooks, 50, 50000);
    await assert.rejects(perBounty.start('bounty', 1, 'agreed'), /per bounty/);
    const daily = new TreasuryCore(store, gateway, hooks, 10000, 50);
    await assert.rejects(daily.start('bounty', 1, 'agreed'), /daily/);
    assert.equal(count.prepare, 0);
});
test('uncertain NEAR recording requires review and never sends a second transfer', async () => {
    const { core, count, flags } = setup();
    await core.start('bounty', 1, 'agreed');
    flags.mined = true;
    flags.recordFails = true;
    await core.reconcile();
    await core.start('bounty', 1, 'agreed');
    await core.reconcile();
    assert.equal(count.prepare, 1);
    assert.equal(count.broadcast, 1);
    assert.equal(count.record, 1);
    assert.equal(core.publicIntent('bounty')?.state, 'NeedsReview');
    await assert.rejects(core.start('another', 1, 'agreed'), /reconciling/);
});
test('transfer evidence binds the exact token, sender, destination and cents', () => {
    const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: source, to: target.address as Hex } });
    const log = { address: DEMO_TOKEN, topics, data: encodeAbiParameters([{ type: 'uint256' }], [10n ** 18n]), logIndex: 2 };
    assert.equal(verifyTreasuryLogs([log], source, target), 2);
    assert.throws(() => verifyTreasuryLogs([{ ...log, address: source }], source, target));
    assert.throws(() => verifyTreasuryLogs([log], target.address, target));
    assert.throws(() => verifyTreasuryLogs([log], source, { ...target, amountCents: 101 }));
    assert.throws(() => verifyTreasuryLogs([log, log], source, target));
    assert.equal(depositReference('0xabc', 2).length, 64);
    assert.notEqual(depositReference('0xabc', 2), depositReference('0xabc', 3));
});
test('treasury cannot operate on mainnet, production payments, or another chain', () => {
    assert(treasuryAllowed('sandbox', 'testnet', 'https://api.monerium.dev', 'basesepolia'));
    for (const args of [['simulation', 'testnet', 'https://api.monerium.dev', 'basesepolia'], ['sandbox', 'mainnet', 'https://api.monerium.dev', 'basesepolia'], ['sandbox', 'testnet', 'https://api.monerium.app', 'basesepolia'], ['sandbox', 'testnet', 'https://api.monerium.dev', 'base']])
        assert(!treasuryAllowed(...args as [
            string,
            string,
            string,
            string
        ]));
});

test('initial preparation is visible immediately and clears after rejection before signing', async () => {
    const { core, count, flags } = setup();
    flags.gas = '0';
    const pending = core.start('bounty', 1, 'agreed');
    assert.equal(core.publicIntent('bounty')?.state, 'Preparing');
    assert.equal(core.publicIntent('bounty')?.hash, null);
    await assert.rejects(pending, /ETH/);
    assert.equal(core.publicIntent('bounty'), null);
    assert.equal(count.broadcast, 0);
});


test('accepted escrow can be funded before GitHub publication; drafts and other owners cannot', () => {
    const b = { ownerId: 1, status: 'AwaitingFunding' as const };
    const t = { ownerId: 1, mode: 'sandbox' as const, clientAccepted: true, funded: false, disputed: false, jobId: 4 };
    assert.equal(acceptsTreasuryFunding(b, t, 1), true);
    assert.equal(acceptsTreasuryFunding({ ...b, status: 'Draft' }, t, 1), false);
    assert.equal(acceptsTreasuryFunding(b, { ...t, clientAccepted: false }, 1), false);
    assert.equal(acceptsTreasuryFunding(b, { ...t, funded: true }, 1), false);
    assert.equal(acceptsTreasuryFunding(b, t, 2), false);
});
