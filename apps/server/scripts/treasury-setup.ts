// One-time operator setup: creates an encrypted server-only key and links its
// public address. Does not move the IBAN, request a faucet, transfer or mint funds.
import { taskRuntime } from '../server/tasks/http.ts';
import { portalRuntime } from '../server/portal/http.ts';
const { service } = await taskRuntime();
const runtime = await portalRuntime(service);
const wallet = await runtime.treasury.setup();
console.log(JSON.stringify({ ...wallet, note: 'Wallet linked. No IBAN was moved and no funds were transferred. Add sandbox EURe and Base Sepolia test ETH once to use it.' }, null, 2));
