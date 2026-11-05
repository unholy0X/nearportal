import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = new URL('./', import.meta.url);
const out = new URL('dist/', root);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['mcp.html', 'mcp.css', 'mcp.js', 'terms.html', 'privacy.html', 'deadline.mjs', 'deadline.css', 'home.html','home.css','home.js','index.html', 'styles.css', 'app.js', 'create.html', 'create.css', 'create.js', 'bounty-model.mjs', 'bounty.html', 'bounty.css', 'bounty.js', 'bounty-detail-model.mjs', 'journey.mjs', 'funding-progress.mjs', 'board.html', 'board.js', 'workspace.css', 'workspace-fonts.css', 'workspace-model.mjs', 'workspace-shell.mjs', 'treasury.html', 'treasury.css', 'treasury.js', 'site.mjs', 'public']) await cp(new URL(file, root), new URL(file, out), { recursive: true });
for (const file of ['public/fonts/manrope.ttf', 'public/fonts/inter.ttf', 'public/fonts/ibm-plex-mono.ttf', 'public/art/aurora-v1/hero-desktop-1600.webp', 'public/art/aurora-v1/hero-mobile-800.webp']) {
  if (!(await stat(new URL(file, out))).size) throw new Error(`Missing asset: ${file}`);
}
// Version local scripts and stylesheets so a deploy is picked up immediately: the edge may keep
// unversioned assets in browsers for hours. One build-wide hash keeps every shared module on a
// single URL, so pages never load two copies of the same module.
const names = (await readdir(out)).filter(name => /\.(?:html|m?js|css)$/.test(name));
const versioned = names.filter(name => /\.(?:m?js|css)$/.test(name));
const hash = createHash('sha256');
for (const name of names.sort()) hash.update(name).update('\0').update(await readFile(new URL(name, out)));
const version = hash.digest('hex').slice(0, 12);
const pattern = new RegExp(`((?:src|href)="|from '|import\\(')/(${versioned.map(name => name.replace(/[.]/g, '\\.')).join('|')})(?=["'])`, 'g');
for (const name of names) {
  const file = new URL(name, out), source = await readFile(file, 'utf8');
  const stamped = source.replace(pattern, `$1/$2?v=${version}`);
  if (stamped !== source) await writeFile(file, stamped);
}
console.log(`Static landing built: ${fileURLToPath(out)} (assets ?v=${version})`);
