/** Preserve the verifier committed by existing escrows when a scoped verifier is rotated.
 * Legacy authorization is explicit and never applies to new deadline agreements. */
export function escrowVerifier(actual: string, current: string, legacy: string | undefined, deadline: boolean): string {
  if (actual === current || (!deadline && legacy && actual === legacy)) return actual;
  throw new Error('Crypto escrow verifier does not match the accepted agreement');
}
