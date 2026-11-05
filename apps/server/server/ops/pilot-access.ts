/** Explicit public access ("*") or a restricted GitHub identity list for testnet. */
export function portalUserAllowed(id: number, value = process.env.PORTAL_ALLOWED_GITHUB_IDS): boolean {
  if (value === undefined) return true;
  if (value === "*") return Number.isSafeInteger(id) && id > 0;
  const ids = value.split(",").map((s) => s.trim());
  if (!ids.length || ids.some((s) => !/^[1-9][0-9]*$/.test(s) || !Number.isSafeInteger(Number(s))))
    throw new Error('PORTAL_ALLOWED_GITHUB_IDS must contain numeric GitHub account IDs or exactly "*" for public access');
  return ids.includes(String(id));
}

export function requirePortalUser(id: number): void {
  if (!portalUserAllowed(id)) throw new Error("This testnet pilot is restricted to its approved GitHub accounts.");
}
