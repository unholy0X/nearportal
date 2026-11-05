// Online, app-local recovery check. Restores only to a fresh directory and never starts workers.
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { backup, encryptionKey } from "./backup.ts";
import { restoreCheck } from "./restore-check.ts";

const dataDir = resolve(process.env.DATA_DIR ?? "data");
const key = encryptionKey(dataDir);
if (!key || key.length !== 32) throw new Error("A valid runtime encryption key is required for the drill");
const name = `drill-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
const out = join(dataDir, "backups", name);
const manifest = backup({ dataDir, dbPath: process.env.TASK_DB ?? join(dataDir, "github-tasks.sqlite"), out });
const restored = restoreCheck({ backup: out, target: join(dataDir, "restore-drills", name), key });
console.log(JSON.stringify({ at: new Date().toISOString(), backup: out, format: manifest.format, keyFingerprint: manifest.keyFingerprint, ...restored }, null, 2));
