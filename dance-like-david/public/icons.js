// Inline stroke icons (no emoji, no icon font). icon('crown', { size: 28 }) -> <svg>.
const P = {
  crown: 'M3 19h18M4 16.5L3 7l5 4 4-7 4 7 5-4-1 9.5z',
  crownFill: 'M4 16.5L3 7l5 4 4-7 4 7 5-4-1 9.5z',
  play: 'M7 4l13 8-13 8z',
  back: 'M15 18l-6-6 6-6',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  user: 'M12 8a3 3 0 100-6 3 3 0 000 6zM6 22v-4a6 6 0 0112 0v4',
  users: 'M8 7a3 3 0 100-6 3 3 0 000 6zM16 7a3 3 0 100-6 3 3 0 000 6zM2 21v-3a5 5 0 0110 0v3M12 21v-3a5 5 0 0110 0v3',
  loop: 'M4 12a8 8 0 0114-5.3M20 4v5h-5M20 12a8 8 0 01-14 5.3M4 20v-5h5',
  star: 'M12 2l3 7 7 .6-5.3 4.7 1.6 7.2L12 17.8 5.7 21.5l1.6-7.2L2 9.6 9 9z',
  check: 'M5 12l5 5 9-10',
  warn: 'M12 7v6M12 17h.01',
  x: 'M6 6l12 12M18 6L6 18',
  wifiOff: 'M2 8.5a15 15 0 0120 0M5 12a10 10 0 0114 0M8.5 15.5a5 5 0 017 0M12 19h.01M3 3l18 18',
  phone: 'M8 2h8a2.5 2.5 0 012.5 2.5v15A2.5 2.5 0 0116 22H8a2.5 2.5 0 01-2.5-2.5v-15A2.5 2.5 0 018 2zM11 18h2',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  camera: 'M3 7h4l2-3h6l2 3h4v13H3zM12 17a4 4 0 100-8 4 4 0 000 8z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  upload: 'M12 16V4M6 10l6-6 6 6M4 20h16',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 11-6 0 3 3 0 016 0zM21 16a3 3 0 11-6 0 3 3 0 016 0z',
  // move pictograms
  left: 'M19 12H5M11 6l-6 6 6 6',
  right: 'M5 12h14M13 6l6 6-6 6',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  spin: 'M20 12a8 8 0 11-3-6.2M20 4v5h-5',
  wave: 'M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',
  clap: 'M8 12l4-8 4 8M6 20h12',
  punch: 'M3 12h7M10 8h7a3 3 0 010 8h-7zM14 8v8',
  rest: 'M8 6v12M16 6v12',
};
export const MOVE_ICONS = ['left', 'right', 'up', 'down', 'spin', 'wave', 'clap', 'punch'];
export const MOVE_ICON_LABELS = { left: 'Arrow left', right: 'Arrow right', up: 'Reach up', down: 'Drop down', spin: 'Spin / roll', wave: 'Wave', clap: 'Clap', punch: 'Punch' };

const NS = 'http://www.w3.org/2000/svg';
export function icon(name, { size = 24, stroke = 'currentColor', fill = 'none', width = 2, cls = 'icon', label } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', fill);
  svg.setAttribute('stroke', stroke);
  svg.setAttribute('stroke-width', width);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('class', cls);
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', P[name] || P.warn);
  svg.append(path);
  return svg;
}

/** A pictogram guess for a move with no icon chosen yet, so every move shows something. */
export const defaultMoveIcon = (i) => MOVE_ICONS[i % MOVE_ICONS.length];

/** Grey dancer silhouette used where no reference video exists. */
export function dancerFigure(width = 300) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 190');
  svg.setAttribute('width', width);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'var(--figure)');
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', 60); c.setAttribute('cy', 22); c.setAttribute('r', 16);
  const b = document.createElementNS(NS, 'path');
  b.setAttribute('d', 'M44 44h32l14 44-10 4-10-30v50l12 70H70l-10-58-10 58H38l12-70V62l-10 30-10-4z');
  svg.append(c, b);
  return svg;
}
