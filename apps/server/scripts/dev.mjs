// Starts the server (tsx watch server/tasks.ts) and the front-end (vite) together.
import { spawn } from "node:child_process";
const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", env: process.env, shell: process.platform === "win32" });
const procs = [run("npx", ["tsx", "watch", "server/tasks.ts"]), run("npx", ["vite"])];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
