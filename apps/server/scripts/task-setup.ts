import { GitHub } from "../server/tasks/github.ts";
import { inspectSetup } from "../server/tasks/setup.ts";
import "../server/env.ts";

const github = new GitHub({ token: process.env.GITHUB_TOKEN, useGhCli: process.env.GITHUB_USE_CLI === "1", appId: process.env.GITHUB_APP_ID, installationId: process.env.GITHUB_INSTALLATION_ID, privateKeyFile: process.env.GITHUB_APP_PRIVATE_KEY_FILE });
try {
  const status = await inspectSetup(github);
  console.log(`GitHub account: ${status.account}`);
  console.log(`Repository: ${status.repository} (${status.branch})`);
  console.log(`Client can merge: ${status.clientCanMerge ? "yes" : "no"}; squash enabled: ${status.squashEnabled ? "yes" : "no"}`);
  for (const file of status.files) console.log(`${file.ready ? "READY" : "MISSING"} ${file.path}`);
  console.log(status.ready ? "Repository setup ready. Add a separate developer when rehearsing a real reward PR." : "Repository setup incomplete: publish the missing setup files to main.");
  console.log("Payments remain simulated. No task or payout was created.");
  process.exitCode = status.ready ? 0 : 1;
} catch (error) { console.error(error instanceof Error ? error.message : "GitHub setup check failed"); process.exitCode = 1; }
