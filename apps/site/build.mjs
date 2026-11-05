import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const out = new URL('dist/', root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['terms.html', 'privacy.html', 'deadline.mjs', 'deadline.css', 'home.html','home.css','home.js','index.html', 'styles.css', 'app.js', 'create.html', 'create.css', 'create.js', 'bounty-model.mjs', 'bounty.html', 'bounty.css', 'bounty.js', 'bounty-detail-model.mjs', 'journey.mjs', 'funding-progress.mjs', 'board.html', 'board.js', 'workspace.css', 'workspace-fonts.css', 'workspace-model.mjs', 'workspace-shell.mjs', 'treasury.html', 'treasury.css', 'treasury.js', 'site.mjs', 'public']) await cp(new URL(file, root), new URL(file, out), { recursive: true });
for (const file of ['public/fonts/manrope.ttf', 'public/fonts/inter.ttf', 'public/fonts/ibm-plex-mono.ttf', 'public/art/aurora-v1/hero-desktop-1600.webp', 'public/art/aurora-v1/hero-mobile-800.webp']) {
  if (!(await stat(new URL(file, out))).size) throw new Error(`Missing asset: ${file}`);
}
console.log(`Static landing built: ${fileURLToPath(out)}`);
