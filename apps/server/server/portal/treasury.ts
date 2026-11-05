import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { env, relayerKey } from '../env.ts';
import { PortalStore, type Bounty } from './store.ts';
import type { Task } from '../tasks/domain.ts';
import type { TaskService } from '../tasks/service.ts';
import { note } from '../tasks/domain.ts';
import { TreasuryCore, type FundingIntent, type TreasuryTarget } from './treasury-core.ts';
import { evmGateway, DEMO_TOKEN } from './treasury-evm.ts';
import { Escrow } from '../../../../services/relayer/src/near.ts';
import { Monerium } from '../../../../services/relayer/src/monerium.ts';
import { bankPaymentsEnabled } from '../ops/payment-rails.ts';
export function treasuryAllowed(mode: string, network: string, api: string, chain: string) { return mode === 'sandbox' && network === 'testnet' && api === 'https://api.monerium.dev' && chain === 'basesepolia'; }
export function acceptsTreasuryFunding(b: Pick<Bounty, 'ownerId' | 'status'>, t: Pick<Task, 'ownerId' | 'mode' | 'clientAccepted' | 'funded' | 'disputed' | 'jobId'> | null, ownerId: number) {
    return b.ownerId === ownerId && b.status !== 'Draft' && Boolean(t && t.ownerId === ownerId && t.mode === 'sandbox' && t.clientAccepted && !t.funded && !t.disputed && t.jobId != null);
}
export function createDemoTreasury(tasks: TaskService, store: PortalStore) {
    let core: TreasuryCore | undefined;
    const safe = () => bankPaymentsEnabled() && treasuryAllowed(tasks.config.mode, env.network, env.monerium.api, env.monerium.chain);
    const allowed = (userId: number) => safe() && Number.isSafeInteger(userId) && userId > 0 && String(userId) === store.meta('operator');
    const cfg = { moneriumApi: env.monerium.api, moneriumClientId: env.monerium.clientId, moneriumClientSecret: env.monerium.clientSecret, chain: env.monerium.chain, nearRpc: env.nearRpc, network: env.network, contractId: env.contractId, relayerAccountId: env.relayer, relayerPrivateKey: '', stateFile: '', pollSeconds: 15 };
    function key() { const sealed = store.meta('demo-treasury-key'); if (!sealed)
        throw new Error('Demo wallet is not set up yet'); return store.open<{
        key: Hex;
    }>(sealed).key; }
    function gateway() { return evmGateway(key(), process.env.DEMO_TREASURY_RPC || 'https://sepolia.base.org'); }
    async function target(bountyId: string, ownerId: number): Promise<TreasuryTarget> {
        if (!allowed(ownerId))
            throw new Error('Only the demo operator can use the sandbox treasury');
        const b = store.bounty(bountyId), t = b.taskId ? tasks.store.get(b.taskId) : null;
        if(b.paymentRail === "base-usdc") throw new Error("EURe treasury cannot fund a USDC bounty");
        if (!t || t.jobId == null || !acceptsTreasuryFunding(b, t, ownerId))
            throw new Error('Bounty must have an accepted, unfunded sandbox escrow');
        const { view, invalidateViews } = await import('../chain.ts');
        invalidateViews();
        const job = await view<any>('get_job', { job_id: t.jobId });
        if (job?.excess_recorded_cents > 0)
            throw new Error('This escrow contains an earlier excess deposit. Reconcile that deposit before adding demo-wallet funds. No new transfer was sent.');
        if (!job || job.state !== 'Signed' || job.deposited_cents !== 0 || job.terms_hash !== (t.fundingPolicyHash ?? t.policyHash) || typeof job.link !== 'object' || !job.link.Signed)
            throw new Error('Escrow is not ready for an exact wallet deposit');
        return { bountyId: b.id, taskId: t.id, ownerId, jobId: t.jobId, amountCents: t.policy.amountCents, policyHash: t.fundingPolicyHash ?? t.policyHash, address: job.escrow_evm_address };
    }
    async function record(intent: FundingIntent, reference: string) {
        await tasks.exclusive(`task:${intent.taskId}`, async () => {
            const current = await target(intent.bountyId, intent.ownerId);
            if ((Object.keys(current) as (keyof TreasuryTarget)[]).some(field => current[field] !== intent[field]))
                throw new Error('Funding target changed');
            const escrow = new Escrow({ ...cfg, relayerPrivateKey: relayerKey(env.relayer) });
            await escrow.recordDeposit(intent.jobId, intent.amountCents, reference);
            const fresh = tasks.store.get(intent.taskId);
            note(fresh, `Demo wallet EURe transfer confirmed on Base Sepolia and recorded on NEAR: ${intent.hash}`);
            tasks.store.save(fresh);
            tasks.store.enqueue(fresh.id);
        });
    }
    function service() { if (!core)
        core = new TreasuryCore(store, gateway(), { target, record }); return core; }
    return {
        allowed,
        async setup() {
            if (!safe() || !store.meta('operator'))
                throw new Error('Demo treasury requires the configured sandbox operator on NEAR testnet');
            if (!store.meta('demo-treasury-key'))
                store.meta('demo-treasury-key', store.seal({ key: generatePrivateKey() }));
            const account = privateKeyToAccount(key());
            const monerium = new Monerium(cfg);
            const message = 'I hereby declare that I am the address owner.';
            await monerium.linkAddress(account.address, message, await account.signMessage({ message }));
            // Linking never moves the active bounty IBAN or mints/transfers funds.
            store.meta('demo-treasury-enabled', '1');
            return { address: account.address, chain: 'basesepolia', token: DEMO_TOKEN };
        },
        async status(userId: number, bountyId?: string) {
            if (!allowed(userId))
                return { available: false };
            if (store.meta('demo-treasury-enabled') !== '1')
                return { available: true, configured: false };
            let funding = null;
            let blockedReason: string | null = null;
            if (bountyId) {
                const b = store.bounty(bountyId);
                if (b.ownerId !== userId)
                    throw new Error('Only the client can view demo funding');
                funding = service().publicIntent(b.id);
                if (!funding) {
                    try { await target(b.id, userId); }
                    catch (error) { const message = error instanceof Error ? error.message : ''; blockedReason = message.startsWith('This escrow contains') || message.startsWith('Bounty must have') || message.startsWith('Escrow is not ready') ? message : 'Unable to verify this escrow right now. Refresh its funding status before sending funds.'; }
                }
            }
            const wallet = gateway();
            let balance;
            try {
                balance = await wallet.balance();
            }
            catch {
                return { available: true, configured: true, address: wallet.address, chain: 'basesepolia', error: 'Unable to read the demo wallet balance. Retry shortly.', maxCents: 10000, funding, blockedReason };
            }
            return { available: true, configured: true, address: wallet.address, chain: 'basesepolia', token: DEMO_TOKEN, ...balance, maxCents: 10000, dailyCents: 50000, funding, blockedReason };
        },
        async fund(userId: number, b: Bounty, policyHash: string) { if (!allowed(userId) || b.ownerId !== userId || store.meta('demo-treasury-enabled') !== '1')
            throw new Error('Demo treasury unavailable for this account'); return service().start(b.id, userId, policyHash); },
        async tick() { if (!safe() || store.meta('demo-treasury-enabled') !== '1')
            return; await service().reconcile(); }
    };
}
