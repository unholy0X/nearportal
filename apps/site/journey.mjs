// Bounty journey — the landing's ribbon and cat guide, as a progress tracker.
// Horizontal wave on wide screens, vertical ribbon on narrow ones. The ribbon is drawn only up to the
// confirmed stage; the guide travels once on arrival and then rests (no looping motion).
const NS = 'http://www.w3.org/2000/svg';
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const svg = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

function geometry(width, vertical) {
  if (vertical) {
    const gap = 88, top = 44, h = top * 2 + gap * 4, x = i => (i % 2 ? 50 : 30);
    const stops = [0, 1, 2, 3, 4].map(i => ({ x: x(i), y: top + i * gap }));
    return { w: width, h, stops, points: [{ x: 40, y: -10 }, ...stops, { x: 40, y: h + 10 }] };
  }
  // Reserve space above AND below the curve for labels at all responsive widths.
  const h = 232, pad = 96, span = (width - pad * 2) / 4, y = i => (i % 2 ? 102 : 132);
  const stops = [0, 1, 2, 3, 4].map(i => ({ x: pad + i * span, y: y(i) }));
  return { w: width, h, stops, labelWidth: Math.min(176, span - 12), points: [{ x: -10, y: 144 }, ...stops, { x: width + 10, y: 90 }] };
}
/** Catmull-Rom through the points as cubic Bézier segments (same curve for full and partial paths). */
function segments(p) {
  const out = [];
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i - 1] || p[i], b = p[i], c = p[i + 1], d = p[i + 2] || c;
    out.push(`C${b.x + (c.x - a.x) / 6},${b.y + (c.y - a.y) / 6} ${c.x - (d.x - b.x) / 6},${c.y - (d.y - b.y) / 6} ${c.x},${c.y}`);
  }
  return out;
}
const pathFor = (p, segs, count = segs.length) => `M${p[0].x},${p[0].y} ${segs.slice(0, count).join(' ')}`;

let previous = null;
/**
 * host: empty element. steps: [{ name, note, state: 'done'|'current'|'todo', alert }].
 * options: { guideSrc }
 */
export function renderJourney(host, steps, { guideSrc = '/public/brand/guide.png' } = {}) {
  const width = Math.round(host.clientWidth || 800), vertical = width < 640;
  const key = JSON.stringify([steps, width, vertical]);
  if (host.dataset.key === key) return;
  host.dataset.key = key;
  const currentIndex = Math.max(0, steps.findIndex(s => s.state === 'current'));
  const allDone = steps.every(s => s.state === 'done');
  const reach = allDone ? steps.length : currentIndex; // stops fully travelled
  const advanced = !previous || reach > previous.reach;
  const animate = advanced && !reduced();
  const from = previous && previous.vertical === vertical ? previous.reach : 0;
  previous = { reach, vertical };

  const g = geometry(width, vertical), segs = segments(g.points);
  host.className = 'journey' + (vertical ? ' journey-vertical' : '') + (allDone ? ' journey-complete' : '');
  host.style.height = g.h + 'px';
  const art = svg('svg', { class: 'journey-art', viewBox: `0 0 ${g.w} ${g.h}`, width: g.w, height: g.h, 'aria-hidden': 'true', focusable: 'false' });
  const reachPoint = allDone ? { x: g.w, y: g.h } : g.stops[currentIndex];
  const defs = svg('defs'), grad = svg('linearGradient', { id: 'journey-gradient', gradientUnits: 'userSpaceOnUse', x1: 0, y1: 0, x2: vertical ? 0 : Math.max(120, reachPoint.x), y2: vertical ? Math.max(120, reachPoint.y) : 0 });
  [['0', '#6E4FB4'], ['.3', '#A07AEB'], ['.7', '#F081BD'], ['1', '#FDA774']].forEach(([o, c]) => grad.append(svg('stop', { offset: o, 'stop-color': c })));
  defs.append(grad); art.append(defs);
  const full = pathFor(g.points, segs);
  // Stop i sits at point i+1; reaching it covers i+1 segments. Completion runs to the far edge.
  const doneD = pathFor(g.points, segs, allDone ? segs.length : currentIndex + 1);
  const trail = svg('path', { d: full, class: 'journey-trail' });
  const under = svg('path', { d: doneD, class: 'journey-under' });
  const ribbon = svg('path', { d: doneD, class: 'journey-ribbon', stroke: 'url(#journey-gradient)' });
  const shine = svg('path', { d: doneD, class: 'journey-shine' });
  art.append(trail, under, ribbon, shine);

  const list = document.createElement('ol'); list.className = 'journey-stops';
  steps.forEach((step, i) => {
    const li = document.createElement('li'), p = g.stops[i];
    li.className = `journey-stop is-${step.state}${step.alert ? ' is-alert' : ''}`;
    li.style.left = p.x + 'px'; li.style.top = p.y + 'px';
    if (step.state === 'current' || (allDone && i === steps.length - 1)) li.setAttribute('aria-current', 'step');
    const dot = document.createElement('span'); dot.className = 'journey-dot'; dot.setAttribute('aria-hidden', 'true');
    dot.textContent = step.state === 'done' ? '✓' : step.alert ? '!' : String(i + 1);
    const label = document.createElement('span'); label.className = 'journey-label';
    if (!vertical) { label.style.width = g.labelWidth + 'px'; label.style.left = -g.labelWidth / 2 + 'px'; }
    const name = document.createElement('strong'); name.textContent = step.name;
    const note = document.createElement('small'); note.textContent = step.note;
    const sr = document.createElement('span'); sr.className = 'ui-visually-hidden';
    sr.textContent = step.state === 'done' ? ', completed' : step.state === 'current' ? (step.alert ? ', current step, needs attention' : ', current step') : ', upcoming';
    label.append(name, note, sr); li.append(dot, label); list.append(li);
  });

  const guide = document.createElement('img');
  guide.className = 'journey-guide' + (steps[currentIndex]?.alert ? ' is-alert' : '');
  guide.src = guideSrc; guide.alt = ''; guide.width = 52; guide.height = 52;
  const halo = document.createElement('span'); halo.className = 'journey-halo' + (steps[currentIndex]?.alert ? ' is-alert' : allDone ? ' is-complete' : '');
  host.replaceChildren(art, list, halo, guide);

  const target = g.stops[allDone ? steps.length - 1 : currentIndex];
  const place = pt => { const t = `translate(${pt.x}px,${pt.y}px)`; guide.style.transform = t + ' translate(-50%,-50%)'; halo.style.transform = t + ' translate(-50%,-50%)'; };
  const doneLength = ribbon.getTotalLength();
  if (!animate) { place(target); return; }
  // Draw the ribbon and let the guide ride it from the previously confirmed stop.
  const startLength = from > 0 ? pathFor(g.points, segs, Math.min(segs.length, from + 1)) : null;
  const probe = startLength ? svg('path', { d: startLength }) : null;
  if (probe) art.append(probe);
  const start = probe ? probe.getTotalLength() : 0; probe?.remove();
  const end = doneLength;
  const lastStopLength = (() => { const q = svg('path', { d: pathFor(g.points, segs, (allDone ? steps.length - 1 : currentIndex) + 1) }); art.append(q); const l = q.getTotalLength(); q.remove(); return l; })();
  for (const n of [under, ribbon, shine]) { n.style.strokeDasharray = `${doneLength} ${doneLength}`; n.style.strokeDashoffset = String(doneLength - start); }
  const t0 = performance.now(), duration = 900;
  const ease = x => 1 - Math.pow(1 - x, 3);
  guide.classList.add('is-travelling');
  const frame = now => {
    const k = ease(Math.min(1, (now - t0) / duration));
    const drawn = start + (end - start) * k;
    for (const n of [under, ribbon, shine]) n.style.strokeDashoffset = String(Math.max(0, doneLength - drawn));
    const at = ribbon.getPointAtLength(Math.min(lastStopLength, start + (lastStopLength - start) * k));
    place(at);
    if (k < 1) requestAnimationFrame(frame);
    else { place(target); guide.classList.remove('is-travelling'); guide.classList.add('is-arrived'); for (const n of [under, ribbon, shine]) { n.style.strokeDasharray = ''; n.style.strokeDashoffset = ''; } }
  };
  requestAnimationFrame(frame);
}
