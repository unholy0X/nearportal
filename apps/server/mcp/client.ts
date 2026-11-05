// HTTP client of the NearPortal agent API. It sends the bearer token only to the origin that issued
// it, after checking that the server identifies itself with that same origin; redirects are never
// followed. A timeout on a mutation is reported as an uncertain outcome, never as a failure.
import { randomUUID } from "node:crypto";

export const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
export function normalizeServer(raw: string, allowHttpLoopback: boolean): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ApiError("invalid_input", `Invalid NearPortal server URL: ${raw}`);
  }
  if (u.username || u.password) throw new ApiError("invalid_input", "The server URL must not contain credentials.");
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw new ApiError("invalid_input", "Give the server origin only, e.g. https://nearportal.com");
  if (u.protocol === "http:") {
    if (!LOOPBACK.has(u.hostname)) throw new ApiError("invalid_input", "HTTPS is required for a NearPortal server that is not on this machine.");
    if (!allowHttpLoopback) throw new ApiError("invalid_input", "Plain HTTP is only allowed for a local loopback server with --allow-http-loopback.");
  } else if (u.protocol !== "https:") throw new ApiError("invalid_input", "The server URL must use https://");
  return u.origin;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
    readonly requestId?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export interface CallOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined | null>;
  mutation?: boolean;
  auth?: boolean;
  timeoutMs?: number;
}
export class NearPortalClient {
  private verified: Promise<void> | null = null;
  constructor(
    readonly origin: string,
    private readonly token: () => string | null,
    private readonly options: { timeoutMs?: number; fetch?: typeof fetch; userAgent?: string } = {},
  ) {}
  /** The server must state the same origin before any credential is sent to it. */
  verify() {
    this.verified ??= (async () => {
      const meta = await this.call<{ service: string; origin: string; apiVersion: number }>("GET", "/api/agent/v1/meta", { auth: false });
      if (meta.service !== "nearportal-agent-api" || meta.apiVersion !== 1) throw new ApiError("provider_unavailable", "This server is not a compatible NearPortal agent API.");
      if (meta.origin !== this.origin) throw new ApiError("invalid_input", `The server identifies as ${meta.origin}, not ${this.origin}. Use its exact origin.`);
    })().catch((error) => {
      this.verified = null;
      throw error;
    });
    return this.verified;
  }
  async call<T>(method: "GET" | "POST", path: string, o: CallOptions = {}): Promise<T> {
    const auth = o.auth !== false;
    const headers: Record<string, string> = { Accept: "application/json", "X-Request-Id": randomUUID(), "User-Agent": this.options.userAgent ?? "nearportal-mcp/1" };
    if (auth) {
      await this.verify();
      const token = this.token();
      if (!token) throw new ApiError("not_authenticated", "Not connected to NearPortal. Run `nearportal-mcp login` in a terminal.");
      headers.Authorization = `Bearer ${token}`;
    }
    if (o.body !== undefined) headers["Content-Type"] = "application/json";
    const url = new URL(path, this.origin);
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(url, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), redirect: "error", signal: AbortSignal.timeout(o.timeoutMs ?? this.options.timeoutMs ?? 20_000) });
    } catch (error) {
      if (o.mutation)
        throw new ApiError("outcome_uncertain", "The request did not complete (timeout or network error). It may or may not have been applied. Do not repeat blindly: read the current state first (get_assignment, get_batch_status), then retry with the same idempotency key.", undefined, headers["X-Request-Id"]);
      throw new ApiError("provider_unavailable", `NearPortal is unreachable (${(error as Error).name === "TimeoutError" ? "timeout" : "network error"}). Retry shortly.`, 10, headers["X-Request-Id"]);
    }
    const requestId = response.headers.get("x-request-id") ?? headers["X-Request-Id"];
    const invalidResponse = () => o.mutation
      ? new ApiError("outcome_uncertain", "The server did not return a complete, valid result. Read the current state before retrying with the same idempotency key.", undefined, requestId, response.status)
      : new ApiError("provider_unavailable", `NearPortal answered with HTTP ${response.status} and no valid result.`, 10, requestId, response.status);
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw invalidResponse();
    }
    if (payload?.ok === false && typeof payload.error?.code === "string" && typeof payload.error?.message === "string") {
      const e = payload.error;
      const retry = Number(response.headers.get("retry-after")) || e.retryAfterSeconds;
      throw new ApiError(typeof e.code === "string" ? e.code : response.status === 429 ? "rate_limited" : "provider_unavailable", typeof e.message === "string" ? e.message : `HTTP ${response.status}`, retry || undefined, payload?.requestId ?? requestId, response.status);
    }
    if (!response.ok || payload?.ok !== true || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw invalidResponse();
    return Object.assign((payload.data ?? {}) as object, { __requestId: payload.requestId ?? requestId }) as T;
  }
}
export const requestIdOf = (value: unknown) => (value && typeof value === "object" && "__requestId" in value ? String((value as { __requestId: string }).__requestId) : "");
