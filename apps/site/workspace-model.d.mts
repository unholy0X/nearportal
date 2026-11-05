// Types for workspace-model.mjs (canonical: apps/site).
export type Role = 'client' | 'developer';
export type StatusKey = 'toFund' | 'available' | 'bidding' | 'awaitingConfirmation' | 'inProgress' | 'inReview' | 'paymentProcessing' | 'refunded' | 'paid' | 'attention';
export type Tone = 'pending' | 'secured' | 'active' | 'success' | 'attention';
export interface Status { key: StatusKey; label: string; tone: Tone; icon: string; stage: 'fund' | 'work' | 'review' | 'payment' | 'paid'; detail: string }
export interface Capabilities { fixedDeadline?: boolean; sealedBid?: boolean }
export interface ModelOptions { capabilities?: Capabilities }
export interface Action { label: string; href: string; external: boolean }
export interface Column { id: string; title: string; stages: string[]; empty: string }
// Structural subset of the public bounty returned by /api/portal/bounties.
export interface BountyLike { branch?: string; preparedPrUrl?: string | null; paymentRail?: "base-usdc"; id: string; ownerId: number; title: string; repository: string; code?: string; status: string; amountCents: number; createdAt?: string; private?: boolean; error?: string | null; marketTerms?: { kind: string } | null; market?: { phase?: 'unfunded' | 'available' | 'bidding' | 'offered' | 'in-progress' | 'in-review' | 'payment-processing' | 'paid' | 'paused' } | null; task?: { evidence?: { merged?: boolean } | null; funded?: boolean; jobId?: number | null; prNumber?: number | null; disputed?: boolean; verdict?: { status?: string } | null; policy?: { developerId?: number | null; developerLogin?: string | null }; refund?: { state?: string }; payment?: { state?: string } } | null }
export const MARKET_PHASES: Readonly<{ bidding: 'bidding'; offered: 'awaitingConfirmation' }>;
export const STATUSES: Record<StatusKey, Omit<Status, 'key' | 'detail'>>;
export const COLUMNS: Record<Role, Column[]>;
export function bountyStatus(b: BountyLike, options?: ModelOptions): Status;
export function columnFor(b: BountyLike, role?: Role, options?: ModelOptions): string;
export function nextAction(b: BountyLike, role?: Role, options?: ModelOptions): Action;
export function scopeBounties<T extends BountyLike>(items: T[], user: { id: number } | null | undefined, role?: Role): T[];
export function filterBounties<T extends BountyLike>(items: T[], filter?: { query?: string; repository?: string }): T[];
export function money(cents: number, rail?: string): string;
export function summary(items: BountyLike[], role?: Role, options?: ModelOptions): string[];

export function pullRequestUrl(b: BountyLike): string;

export function editorUrl(b: BountyLike): string;
