import type { IncomingMessage, ServerResponse } from "node:http";
import type { PaymentAdapter } from "../tasks/payments.ts";
import { requestId } from "./log.ts";
import { randomUUID } from "node:crypto";

export const maintenanceEnabled = () => process.env.NEARPORTAL_MAINTENANCE === "1";
export const MAINTENANCE_MESSAGE = "Maintenance: sign-in and status reads are available; bounty changes, funding instructions and payment workers are paused.";

/** Keep authentication/revocation usable, but fail closed for every business mutation.
 * Funding instructions are hidden too: do not invite deposits while reconciliation is paused.
 * Call this before routing, so future mutation routes are also denied by default.
 */
export function maintenanceGate(req: IncomingMessage, res: ServerResponse): boolean {
  if (!maintenanceEnabled()) return false;
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = req.method ?? "GET";
  const funding = path === "/api/agent/v1/funding" || /^\/api\/(portal\/bounties|tasks)\/[^/]+\/deposit$/.test(path);
  if (!funding && ["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  if (method === "POST" && (
    ["/auth/logout", "/api/agent/device/code", "/api/agent/device/token", "/api/agent/device/decision", "/api/agent/v1/logout"].includes(path) ||
    /^\/api\/agent\/session\/tokens\/[a-f0-9-]{36}\/revoke$/.test(path)
  )) return false;
  const id = requestId() ?? randomUUID();
  res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-Id": id, "X-Content-Type-Options": "nosniff" });
  res.end(JSON.stringify(path.startsWith("/api/agent/")
    ? { ok: false, requestId: id, error: { code: "capability_disabled", message: MAINTENANCE_MESSAGE } }
    : { error: MAINTENANCE_MESSAGE, code: "maintenance_mode" }));
  return true;
}

/** Maintenance can boot without custody keys or banking credentials. Even an accidental
 * internal call fails before touching a payment provider. Normal startup still validates keys.
 */
export function pausedPayments(): PaymentAdapter {
  const denied = async (): Promise<never> => { throw new Error(MAINTENANCE_MESSAGE); };
  return { prepare: denied, sync: denied, release: denied, dispute: denied, deposit: denied };
}
