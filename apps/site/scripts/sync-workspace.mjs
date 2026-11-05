// Copies the canonical workspace system into the React app so both frontends share one source.
// Usage: npm run sync:workspace [-- --check]   (APP_DIR overrides the default apps/server path)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHARED_FILES = ['workspace.css', 'workspace-model.mjs', 'workspace-model.d.mts', 'workspace-shell.mjs', 'workspace-shell.d.mts'];
const landing = fileURLToPath(new URL('../', import.meta.url));
export const appDir = path.resolve(process.env.APP_DIR || path.join(landing, '../server'));
const target = path.join(appDir, 'src/workspace');

export async function drift() {
  const out = [];
  for (const file of SHARED_FILES) {
    const source = await readFile(path.join(landing, file));
    const copy = existsSync(path.join(target, file)) ? await readFile(path.join(target, file)) : null;
    if (!copy || !copy.equals(source)) out.push(file);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!existsSync(appDir)) { console.error(`React app not found at ${appDir}. Set APP_DIR.`); process.exit(1); }
  if (process.argv.includes('--check')) {
    const changed = await drift();
    if (changed.length) { console.error('Out of sync: ' + changed.join(', ') + '. Run npm run sync:workspace.'); process.exit(1); }
    console.log('Workspace system in sync.'); process.exit(0);
  }
  await mkdir(target, { recursive: true });
  for (const file of SHARED_FILES) await writeFile(path.join(target, file), await readFile(path.join(landing, file)));
  await writeFile(path.join(target, 'README.md'), `# Shared workspace system — do not edit here\n\nThese files are copied from \`apps/site\` by \`npm run sync:workspace\` (run in \`apps/site\`).\nEdit the canonical files there, then sync. \`npm test\` in \`apps/site\` fails when this copy drifts.\n`);
  console.log(`Synced ${SHARED_FILES.length} files to ${target}`);
}
