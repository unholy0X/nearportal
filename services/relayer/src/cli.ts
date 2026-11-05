// Usage:
//   npm run relayer -- register <jobId> <artisan.json> <client.json> [--move-iban]
//   npm run relayer -- once
//   npm run relayer -- watch
// Party files: {"iban":"FR76...","firstName":"Marc","lastName":"Durand","country":"FR"}
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { Monerium } from "./monerium.ts";
import { Escrow } from "./near.ts";
import { runPass } from "./relayer.ts";
import { Store } from "./store.ts";
import type { Party } from "./logic.ts";

const log = (msg: string) => console.log(`${new Date().toISOString()}  ${msg}`);
const [command, ...rest] = process.argv.slice(2);
const cfg = loadConfig();
const store = new Store(cfg.stateFile);

if (command === "register") {
  const [jobId, artisanFile, clientFile] = rest;
  if (!jobId || !artisanFile || !clientFile) throw new Error("register <jobId> <artisan.json> <client.json> [--move-iban]");
  const read = (f: string) => JSON.parse(readFileSync(f, "utf8")) as Party;
  store.state.jobs[jobId] = { artisan: read(artisanFile), client: read(clientFile), moveIbanHere: rest.includes("--move-iban") };
  store.save();
  log(`job ${jobId} registered`);
} else if (command === "once" || command === "watch") {
  const escrow = new Escrow(cfg);
  const monerium = new Monerium(cfg);
  const relayer = (await escrow.config()).relayer;
  if (relayer !== cfg.relayerAccountId) throw new Error(`Contract relayer is ${relayer}, not ${cfg.relayerAccountId}`);
  do {
    try {
      await runPass(escrow, monerium, store, log);
    } catch (e) {
      log(`error: ${e instanceof Error ? e.message : String(e)}`);
      if (command === "once") process.exitCode = 1;
    }
    if (command === "watch") await new Promise((r) => setTimeout(r, cfg.pollSeconds * 1000));
  } while (command === "watch");
} else {
  console.log("Commands: register <jobId> <artisan.json> <client.json> [--move-iban] | once | watch");
}
