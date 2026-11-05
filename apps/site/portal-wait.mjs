// Waiting and celebration marks built from the approved NearPortal logo (unchanged raster artwork,
// animated as a whole). Text always states the phase; the artwork is decorative.
const CYCLE_MS = 9600; // common multiple of every looping animation in portal-wait.css

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Cards are rebuilt on each refresh; a shared clock keeps the animation continuous across rebuilds. */
function sync(node, offsetMs) { node.style.setProperty('--np-delay', `-${Math.round(offsetMs)}ms`); }

function stage(src, extra) {
  const art = el('div', 'portal-wait-stage');
  art.setAttribute('aria-hidden', 'true');
  art.append(el('span', 'portal-wait-glow'), el('span', 'portal-wait-ring'), el('span', 'portal-wait-shadow'));
  for (let i = 1; i <= 3; i++) art.append(el('span', `portal-wait-spark portal-wait-spark-${i}`));
  const cat = el('img', 'portal-wait-cat'); cat.src = src; cat.alt = ''; cat.width = 56; cat.height = 56; cat.decoding = 'async';
  art.append(cat);
  if (extra) art.append(extra);
  return art;
}

function copy(title, detail, note) {
  const text = el('div', 'portal-wait-copy');
  text.setAttribute('role', 'status'); text.setAttribute('aria-live', 'polite');
  text.append(el('strong', '', title));
  if (detail) text.append(el('p', '', detail));
  if (note) { const live = el('small', 'portal-wait-live'); live.append(el('span', 'portal-wait-dot'), document.createTextNode(note)); text.append(live); }
  return text;
}

/**
 * phase: 'preparing' (escrow or address being created), 'watching' (waiting for the deposit),
 * 'busy' (a request in flight).
 */
export function portalWait({ phase = 'watching', title, detail, note = 'Updates automatically', src = '/public/brand/guide.png' }) {
  const box = el('div', `portal-wait is-${phase}`);
  sync(box, performance.now() % CYCLE_MS);
  box.append(stage(src), copy(title, detail, note));
  return box;
}

/** One-shot celebration; `startedAt` (Date.now() ms) keeps it in step if the card is rebuilt mid-way. */
export function portalCelebrate({ title, detail, startedAt = Date.now(), src = '/public/brand/guide.png' }) {
  const box = el('div', 'portal-wait is-celebrating');
  sync(box, Math.max(0, Date.now() - startedAt));
  const burst = el('span', 'portal-burst');
  for (let i = 0; i < 10; i++) { const spark = el('i'); spark.style.setProperty('--np-angle', `${i * 36}deg`); burst.append(spark); }
  box.append(stage(src, burst), copy(title, detail));
  return box;
}

export const CELEBRATION_MS = 4200;
