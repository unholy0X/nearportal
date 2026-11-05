// Minimal Monerium API v2 client (Private app, client credentials).
import type { Config } from "./config.ts";

const V2 = { Accept: "application/vnd.monerium.api-v2+json" };

export interface MoneriumOrder {
  id: string;
  kind: "issue" | "redeem";
  address: string;
  chain: string;
  amount: string;
  state: "placed" | "pending" | "processed" | "rejected";
  memo?: string;
}

export class MoneriumRequestError extends Error {
  constructor(readonly status: number, method: string, path: string, response: string) { super(`Monerium ${method} ${path} → ${status} ${response}`); }
}

export class Monerium {
  #token?: { value: string; expiresAt: number };

  constructor(private readonly cfg: Config) {}

  async #auth(): Promise<string> {
    if (this.#token && Date.now() < this.#token.expiresAt - 60_000) return this.#token.value;
    const res = await fetch(`${this.cfg.moneriumApi}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.cfg.moneriumClientId,
        client_secret: this.cfg.moneriumClientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Monerium auth failed: ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.#token = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return body.access_token;
  }

  async #call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const send = async () => fetch(`${this.cfg.moneriumApi}${path}`, {
      method,
      headers: { ...V2, "Content-Type": "application/json", Authorization: `Bearer ${await this.#auth()}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    let res = await send();
    // A token revoked or expired early is renewed once. A 401 means the request was not
    // processed, so repeating it (even a POST) cannot create a duplicate order.
    if (res.status === 401) {
      this.#token = { value: "", expiresAt: 0 }; // force renewal
      res = await send();
    }
    const text = await res.text();
    const data = (text ? JSON.parse(text) : null) as T;
    if (res.status >= 400) throw new MoneriumRequestError(res.status, method, path, text);
    return { status: res.status, data };
  }

  async profileId(): Promise<string> {
    const { data } = await this.#call<{ defaultProfile: string }>("GET", "/auth/context");
    return data.defaultProfile;
  }

  async ibans(): Promise<{ iban: string; address: string; chain: string }[]> {
    return (await this.#call<{ ibans: { iban: string; address: string; chain: string }[] }>("GET", "/ibans")).data.ibans ?? [];
  }

  async ordersFor(address: string): Promise<MoneriumOrder[]> {
    const { data } = await this.#call<{ orders: MoneriumOrder[] }>("GET", `/orders?address=${address}`);
    return (data.orders ?? []).filter(order => order.address?.toLowerCase() === address.toLowerCase() && order.chain === this.cfg.chain);
  }

  async order(id: string): Promise<MoneriumOrder> {
    return (await this.#call<MoneriumOrder>("GET", `/orders/${id}`)).data;
  }

  /** Links an address with its ownership signature. Returns false if it was already linked. */
  async linkAddress(address: string, message: string, signature: string): Promise<boolean> {
    try {
      const profile = await this.profileId();
      await this.#call("POST", "/addresses", { profile, address, chain: this.cfg.chain, message, signature });
      return true;
    } catch (e) {
      if (String(e).includes("→ 409")) return false;
      throw e;
    }
  }

  /** Moves the profile's IBAN to `address` (sandbox demo: one IBAN per profile). */
  async moveIban(address: string): Promise<void> {
    const { data } = await this.#call<{ ibans: { iban: string }[] }>("GET", "/ibans");
    const iban = data.ibans[0]?.iban.replace(/\s/g, "");
    if (!iban) throw new Error("No IBAN on the Monerium profile");
    await this.#call("PATCH", `/ibans/${iban}`, { address, chain: this.cfg.chain });
  }

  async uploadSupportingDocument(content: Uint8Array, name: string): Promise<{ id: string }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(content)], { type: 'application/pdf' }), name);
    const res = await fetch(`${this.cfg.moneriumApi}/files`, { method: 'POST', headers: { ...V2, Authorization: `Bearer ${await this.#auth()}` }, body: form });
    const text = await res.text();
    if (!res.ok) throw new MoneriumRequestError(res.status, 'POST', '/files', text);
    return JSON.parse(text) as { id: string };
  }

  async placeRedeem(order: {
    id?: string;
    supportingDocumentId?: string;
    address: string;
    amount: string;
    counterpart: unknown;
    message: string;
    signature: string;
    memo: string;
  }): Promise<MoneriumOrder> {
    return (await this.#call<MoneriumOrder>("POST", "/orders", { kind: "redeem", currency: "eur", chain: this.cfg.chain, ...order })).data;
  }
}
