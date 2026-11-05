// Cached read model for list and Home queries. All bounties and their tasks are parsed once per
// data version (any task or bounty write bumps it) instead of once per request; global Home
// aggregates are shared by every visitor and recomputed only after a relevant change.
// Personal data is computed per user from that user's own records and never cached across users.
import { bountyStatus, STATUSES, type Capabilities, type StatusKey } from "../../src/workspace/workspace-model.mjs";
import { homeSnapshot } from "./home.ts";
import { dataVersion } from "../ops/version.ts";
import { TtlCache } from "../ops/provider.ts";
import { metrics } from "../ops/metrics.ts";
import type { Bounty, PortalStore } from "./store.ts";
import type { TaskStore } from "../tasks/store.ts";
import type { Task } from "../tasks/domain.ts";

export interface Entry {
  b: Bounty;
  t: Task | null;
  status: StatusKey;
}
export type Scope = "mine" | "work" | "explore" | "all";
export const MAX_PAGE_SIZE = 100;
// Status labels can depend on time (auction phases), so even an unchanged version expires.
const STATUS_TTL_MS = 30_000;

export class ReadModel {
  private snapshot?: { version: number; at: number; entries: Entry[]; byId: Map<string, Entry> };
  private homes = new TtlCache<ReturnType<typeof homeSnapshot>>(200);
  constructor(
    private readonly store: PortalStore,
    private readonly tasks: TaskStore,
    private readonly capabilities: Capabilities,
  ) {}
  entries() {
    const version = dataVersion();
    const now = Date.now();
    if (this.snapshot && this.snapshot.version === version && now - this.snapshot.at < STATUS_TTL_MS) {
      metrics.inc("read_model_hits_total");
      return this.snapshot;
    }
    const started = now;
    const bounties = this.store.all();
    const taskMap = this.tasks.many(bounties.flatMap((b) => (b.taskId ? [b.taskId] : [])));
    const entries = bounties.map((b) => {
      const t = b.taskId ? taskMap.get(b.taskId) ?? null : null;
      return { b, t, status: bountyStatus({ ...b, task: t }, { capabilities: this.capabilities }).key as StatusKey };
    });
    this.snapshot = { version, at: now, entries, byId: new Map(entries.map((e) => [e.b.id, e])) };
    this.homes = new TtlCache(200);
    metrics.inc("read_model_rebuilds_total");
    metrics.observe("read_model_rebuild_ms", Date.now() - started);
    return this.snapshot;
  }
  task(b: Bounty) {
    return this.entries().byId.get(b.id)?.t ?? null;
  }
  /** Home: shared global part + this user's personal counters. */
  home(userId: number | undefined, filter: string, page: number) {
    const { entries } = this.entries();
    const key = `${filter}:${page}`;
    let global = this.homes.get(key);
    if (!global) {
      global = homeSnapshot(entries.map((e) => e.b), (b) => this.snapshot!.byId.get(b.id)?.t ?? null, undefined, this.capabilities, filter, page);
      this.homes.set(key, global, STATUS_TTL_MS);
    }
    if (!userId) return global;
    const own = entries.filter((e) => e.b.ownerId === userId || e.t?.policy.developerId === userId);
    const personal = homeSnapshot(own.map((e) => e.b), (b) => this.snapshot!.byId.get(b.id)?.t ?? null, userId, this.capabilities, "", 1).personal;
    const devOf = (id: string) => this.snapshot!.byId.get(id)?.t?.policy.developerId;
    return { ...global, personal, rows: global.rows.map((r) => ({ ...r, assignedToYou: devOf(r.id) === userId })) };
  }
  /**
   * One page of bounties for a scope, filtered on the server. `visible` applies the caller's read
   * permission.
   */
  page(
    options: { userId?: number; scope: Scope; status?: string; q?: string; repository?: string; page?: number; limit?: number },
    visible: (b: Bounty) => boolean,
    where: (e: Entry) => boolean = () => true,
  ) {
    const { scope, userId } = options;
    if (options.status && !Object.hasOwn(STATUSES, options.status)) throw new Error("Unknown bounty status");
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(options.limit) || 50)));
    const q = (options.q ?? "").trim().toLowerCase().slice(0, 200);
    const inScope = this.entries().entries.filter(({ b, t }) => {
      if (scope === "mine") return Boolean(userId) && b.ownerId === userId;
      if (scope === "work") return Boolean(userId) && t?.policy.developerId === userId && b.ownerId !== userId;
      if (scope === "explore") return b.published;
      return b.published || b.ownerId === userId || (Boolean(userId) && t?.policy.developerId === userId);
    }).filter(({ b }) => visible(b)).filter(where);
    // Counts follow the search and repository filters but not the status filter, so every status
    // tab shows how many results it would return.
    const counts = Object.fromEntries(Object.keys(STATUSES).map((k) => [k, 0])) as Record<StatusKey, number>;
    const repositories = new Set<string>();
    const searched = inScope.filter(({ b }) =>
      (!options.repository || b.repository === options.repository) &&
      (!q || [b.title, b.repository, b.code, b.owner].some((v) => String(v).toLowerCase().includes(q))),
    );
    for (const e of inScope) repositories.add(e.b.repository);
    for (const e of searched) counts[e.status]++;
    const matching = searched.filter(({ status }) => !options.status || status === options.status);
    const pages = Math.max(1, Math.ceil(matching.length / limit));
    const page = Math.min(pages, Math.max(1, Math.floor(Number(options.page) || 1)));
    return {
      items: matching.slice((page - 1) * limit, page * limit).map((e) => e.b),
      page,
      pages,
      total: matching.length,
      limit,
      counts,
      repositories: [...repositories].sort().slice(0, 500),
    };
  }
}
