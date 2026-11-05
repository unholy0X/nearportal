import { createHash } from 'node:crypto';
import type { PortalStore } from './store.ts';
export interface TreasuryTarget {
    bountyId: string;
    taskId: string;
    ownerId: number;
    jobId: number;
    amountCents: number;
    policyHash: string;
    address: string;
}
export interface FundingIntent extends TreasuryTarget {
    state: 'Signed' | 'Pending' | 'Recording' | 'Recorded' | 'NeedsReview' | 'Failed';
    hash: string;
    raw: string;
    createdAt: string;
    error: string | null;
}
export interface TreasuryGateway {
    balance(): Promise<{
        balanceCents: number;
        gasWei: string;
    }>;
    prepare(address: string, cents: number): Promise<{
        hash: string;
        raw: string;
    }>;
    broadcast(raw: string): Promise<void>;
    receipt(hash: string, target: TreasuryTarget): Promise<{
        reference: string;
    } | null>;
}
export interface TreasuryHooks {
    target(bountyId: string, ownerId: number): Promise<TreasuryTarget>;
    record(intent: FundingIntent, reference: string): Promise<void>;
}
export function depositReference(hash: string, logIndex: number) { return createHash('sha256').update(`nearportal:84532:${hash.toLowerCase()}:${logIndex}`).digest('hex'); }
export class TreasuryCore {
    private chain: Promise<unknown> = Promise.resolve();
    private preparing = new Map<string, number>();
    constructor(private store: PortalStore, private gateway: TreasuryGateway, private hooks: TreasuryHooks, readonly maxCents = 10000, readonly dailyCents = 50000) {
        store.db.exec('CREATE TABLE IF NOT EXISTS portal_treasury_funding(bounty_id TEXT PRIMARY KEY, tx_hash TEXT NOT NULL UNIQUE, body TEXT NOT NULL)');
    }
    private exclusive<T>(run: () => Promise<T>): Promise<T> { const next = this.chain.catch(() => { }).then(run); this.chain = next; return next; }
    private save(intent: FundingIntent) { this.store.db.prepare('INSERT INTO portal_treasury_funding VALUES(?,?,?) ON CONFLICT(bounty_id) DO UPDATE SET body=excluded.body').run(intent.bountyId, intent.hash, this.store.seal(intent)); }
    intent(id: string): FundingIntent | undefined { const row = this.store.db.prepare('SELECT body FROM portal_treasury_funding WHERE bounty_id=?').get(id) as {
        body: string;
    } | undefined; return row ? this.store.open<FundingIntent>(row.body) : undefined; }
    private all() { return (this.store.db.prepare('SELECT body FROM portal_treasury_funding').all() as {
        body: string;
    }[]).map(r => this.store.open<FundingIntent>(r.body)); }
    publicIntent(id: string) { const intent = this.intent(id); return intent ? { state: intent.state, hash: intent.hash, amountCents: intent.amountCents, error: intent.error } : this.preparing.has(id) ? { state: 'Preparing', hash: null, amountCents: null, error: null } : null; }
    start(bountyId: string, ownerId: number, policyHash: string) {
        this.preparing.set(bountyId, (this.preparing.get(bountyId) ?? 0) + 1);
        return this.exclusive(async () => {
            const existing = this.intent(bountyId);
            if (existing) {
                if (existing.ownerId !== ownerId || existing.policyHash !== policyHash)
                    throw new Error('Funding agreement changed');
                return this.publicIntent(bountyId);
            }
            const target = await this.hooks.target(bountyId, ownerId);
            if (target.bountyId !== bountyId || target.ownerId !== ownerId)
                throw new Error('Funding owner or bounty mismatch');
            if (target.policyHash !== policyHash)
                throw new Error('Refresh and review the current funding agreement');
            if (!Number.isSafeInteger(target.amountCents) || target.amountCents < 1 || target.amountCents > this.maxCents)
                throw new Error(`Demo wallet limit is EUR ${(this.maxCents / 100).toFixed(2)} per bounty`);
            const today = new Date().toISOString().slice(0, 10);
            if (this.all().filter(i => i.createdAt.startsWith(today)).reduce((n, i) => n + i.amountCents, 0) + target.amountCents > this.dailyCents)
                throw new Error('Demo wallet daily funding limit reached');
            // Reserve this wallet nonce globally. Uncertain transfers must reconcile before another signature.
            if (this.all().some(i => !['Recorded', 'Failed'].includes(i.state)))
                throw new Error('A demo wallet transfer is still reconciling; wait before funding another bounty');
            const balance = await this.gateway.balance();
            if (balance.balanceCents < target.amountCents)
                throw new Error('Top up the demo wallet with test EURe first');
            if (BigInt(balance.gasWei) === 0n)
                throw new Error('Add Base Sepolia test ETH to the demo wallet for transaction fees');
            let transaction;
            try {
                transaction = await this.gateway.prepare(target.address, target.amountCents);
            }
            catch {
                throw new Error('Unable to prepare the demo transfer. Check test gas, escrow balance and RPC availability. No transfer was sent.');
            }
            const intent: FundingIntent = { ...target, ...transaction, state: 'Signed', createdAt: new Date().toISOString(), error: null };
            // Exact signed bytes and hash are durable BEFORE broadcasting. Retries never sign a second transfer.
            this.save(intent);
            try {
                await this.gateway.broadcast(intent.raw);
                intent.state = 'Pending';
                this.save(intent);
            }
            catch {
                intent.error = 'Broadcast outcome uncertain. The same signed transfer will be reconciled; no replacement will be sent.';
                this.save(intent);
            }
            return this.publicIntent(bountyId);
        }).finally(() => {
            const remaining = (this.preparing.get(bountyId) ?? 1) - 1;
            if (remaining) this.preparing.set(bountyId, remaining);
            else this.preparing.delete(bountyId);
        });
    }
    reconcile() {
        return this.exclusive(async () => {
            for (const intent of this.all().filter(i => ['Signed', 'Pending', 'Recording'].includes(i.state))) {
                try {
                    const receipt = await this.gateway.receipt(intent.hash, intent);
                    if (!receipt) {
                        if (intent.state === 'Signed') {
                            await this.gateway.broadcast(intent.raw);
                            intent.state = 'Pending';
                            intent.error = null;
                            this.save(intent);
                        }
                        continue;
                    }
                    if (intent.state === 'Recording') {
                        intent.state = 'NeedsReview';
                        intent.error = 'Transfer confirmed; NEAR recording outcome needs reconciliation. No second transfer will be sent.';
                        this.save(intent);
                        continue;
                    }
                    intent.state = 'Recording';
                    intent.error = null;
                    this.save(intent);
                    try {
                        await this.hooks.record(intent, receipt.reference);
                        intent.state = 'Recorded';
                        this.save(intent);
                    }
                    catch {
                        intent.state = 'NeedsReview';
                        intent.error = 'Transfer confirmed; verify NEAR deposit recording before continuing. No second transfer will be sent.';
                        this.save(intent);
                    }
                }
                catch (error) {
                    if (error instanceof InvalidTreasuryReceipt) {
                        intent.state = 'Failed';
                        intent.error = error.message;
                        this.save(intent);
                    }
                }
            }
        });
    }
}
export class InvalidTreasuryReceipt extends Error {
}
