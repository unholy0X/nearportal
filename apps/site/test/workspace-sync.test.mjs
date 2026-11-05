import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { drift, appDir } from '../scripts/sync-workspace.mjs';

test('the React app uses an identical copy of the shared workspace system', { skip: !existsSync(appDir) && 'React app not checked out next to the landing' }, async () => {
  assert.deepEqual(await drift(), [], 'Run `npm run sync:workspace` after editing workspace.* files');
});

test('the shared stylesheet uses only the locked Aurora Portal colors', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../workspace.css', import.meta.url), 'utf8');
  const palette = JSON.parse(await readFile(new URL('../../../design/aurora-portal/palette-sampled.json', import.meta.url), 'utf8'));
  const allowed = new Set(Object.values(palette.colors).map(c => c.hex.toUpperCase()));
  const used = new Set((css.match(/#[0-9a-f]{3,8}\b/gi) || []).map(x => x.toUpperCase()));
  assert.deepEqual([...used].filter(x => !allowed.has(x)), []);
  assert.doesNotMatch(css, /\brgba?\(|\bhsla?\(/, 'Use color-mix of locked tokens, not ad-hoc colors');
});
