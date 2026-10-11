// Channel strips: fader, meter, mute/solo and the name plate.
import * as net from './net.js';
import { h, capture, formatDb, formatPan } from './ui.js';

const M = window.MixerModel;

export const PALETTE = [
  '#e5484d', '#f2743a', '#ffb000', '#e8d44d', '#8ecf3c', '#30a46c',
  '#19b3a6', '#3cb8e6', '#4c8dff', '#7a6cf0', '#c05bd8', '#ee5ea0',
  '#a9b1bb', '#6d7782',
];

const DEFAULT_COLOR = { input: '#6d7782', stereo: '#19b3a6', fx: '#f2743a', aux: '#4c8dff', main: '#e5484d' };

export function defaultColor(strip) {
  if (strip.kind === 'input' && strip.blocks.length > 1) return DEFAULT_COLOR.stereo;
  return DEFAULT_COLOR[strip.kind];
}

export function stripColor(strip) {
  const saved = net.state.meta.strips[strip.id];
  return saved && saved.color ? saved.color : defaultColor(strip);
}

export function stripName(strip) {
  return net.state.names[strip.nameSlots[0]] || strip.label;
}

// Readable text colour (dark or light) for a label sitting on `hex`.
export function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#101114' : '#ffffff';
}

// --- parameter bindings --------------------------------------------------------
// A registry ties addresses to the DOM updates they drive. Each screen owns
// one and clears it when its strips are rebuilt.
const registries = new Set();

export function createRegistry() {
  const registry = {
    bindings: new Map(),
    meters: [],
    bind(addrs, update) {
      for (const a of addrs) {
        if (!this.bindings.has(a)) this.bindings.set(a, []);
        this.bindings.get(a).push(update);
      }
      update();
    },
    clear() {
      this.bindings = new Map();
      this.meters = [];
    },
    dispose() {
      this.clear();
      registries.delete(this);
    },
  };
  registries.add(registry);
  return registry;
}

net.on('params', (changed) => {
  const run = new Set();
  for (const registry of registries) {
    for (const a of changed) for (const fn of registry.bindings.get(a) || []) run.add(fn);
  }
  run.forEach((fn) => fn());
});
// Run the updates bound to these addresses although no value changed.
function refresh(addrs) {
  const run = new Set();
  for (const registry of registries) {
    for (const a of addrs) for (const fn of registry.bindings.get(a) || []) run.add(fn);
  }
  run.forEach((fn) => fn());
}

// --- send mute -----------------------------------------------------------------
// The mixer has no on/off switch for a single send. Muting one turns its
// level down and keeps the level with the bridge, to bring it back on unmute.
const mutedLevels = (mixId) => (net.state.meta.mixes[mixId] || {}).muted || {};

// A send someone has turned up again is no longer muted, whatever was kept.
// Pre or post fader for every send into one AUX at once. Returns 'pre',
// 'post' or 'mixed'; only AUX mixes have the choice.
export function sendsPreState(mixId) {
  let pre = 0, post = 0;
  for (const s of M.STRIPS) {
    if (!M.isSource(s, mixId)) continue;
    for (const a of M.sendAddrs(s, mixId)) {
      if (net.get(a) & M.FLAG_PRE) pre++; else post++;
    }
  }
  return pre && post ? 'mixed' : pre ? 'pre' : 'post';
}

export function setAllSendsPre(mixId, pre) {
  const pairs = [];
  for (const s of M.STRIPS) {
    if (!M.isSource(s, mixId)) continue;
    for (const a of M.sendAddrs(s, mixId)) pairs.push([a, (net.get(a) & M.LEVEL_MASK) | (pre ? M.FLAG_PRE : 0)]);
  }
  net.set(pairs);
}

export function isSendMuted(strip, mixId) {
  const level = net.get(M.sendAddrs(strip, mixId)[0]) & M.LEVEL_MASK;
  return strip.id in mutedLevels(mixId) && level === 0;
}

export function setSendMuted(strip, mixId, mute) {
  const addrs = M.sendAddrs(strip, mixId);
  const saved = net.state.meta.mixes[mixId] || {};
  const muted = { ...(saved.muted || {}) };
  const level = net.get(addrs[0]) & M.LEVEL_MASK;
  let next = level;
  if (mute) {
    muted[strip.id] = level;
    next = 0;
  } else {
    if (level === 0) next = muted[strip.id] || 0;
    delete muted[strip.id];
  }
  net.patchMeta(['mixes', mixId], { ...saved, muted }, { quiet: true });
  net.set(addrs.map((a) => [a, (net.get(a) & M.FLAG_PRE) | next]));
  refresh(addrs);
}

net.on('reset', () => {
  for (const registry of registries) for (const list of registry.bindings.values()) list.forEach((fn) => fn());
});

// --- meters --------------------------------------------------------------------
// The bar falls back at this rate, like the mixer's own meter, so that short
// peaks can be read.
const FALL_DB_PER_SECOND = 20;
const PEAK_HOLD = 1400;

function drawMeters(now) {
  const bytes = net.state.meters;
  for (const registry of registries) {
    for (const view of registry.meters) {
      view.bars.forEach((bar, i) => {
        const byte = bytes[M.meterIndex(view.indexes[i])] ?? M.METER_FLOOR;
        const fell = bar.db - (FALL_DB_PER_SECOND * (now - bar.at)) / 1000;
        const db = Math.max(M.meterToDb(byte), fell);
        bar.db = db;
        bar.at = now;
        const level = M.meterToPos(db);
        if (level !== bar.level) {
          bar.level = level;
          bar.fill.style.setProperty('--lv', `${(level * 100).toFixed(1)}%`);
        }
        if (level >= bar.peak || now - bar.peakAt > PEAK_HOLD) {
          bar.peak = level;
          bar.peakAt = now;
          bar.mark.style.bottom = `${level * 100}%`;
          bar.mark.style.opacity = level > 0.01 ? 1 : 0;
          // The peak mark turns red when the level reached the red zone.
          bar.mark.classList.toggle('is-over', db >= M.METER_RED);
        }
      });
    }
  }
}
net.on('meters', () => requestAnimationFrame(drawMeters));

function createMeter(registry, indexes) {
  const bars = indexes.map(() => {
    const fill = h('div', { class: 'meter-fill' });
    const mark = h('div', { class: 'meter-peak' });
    return { fill, mark, level: -1, db: -99, at: 0, peak: 0, peakAt: 0, el: h('div', { class: 'meter-bar' }, fill, mark) };
  });
  registry.meters.push({ indexes, bars });
  return h('div', { class: `meter${indexes.length > 1 ? ' is-stereo' : ''}` }, bars.map((b) => b.el));
}

// --- fader ---------------------------------------------------------------------
const SCALE_MARKS = [10, 5, 0, -5, -10, -20, -30, -40, -60];

// `addrs` hold the level; `merge` builds the value to write from the stored
// value and the new level (send levels share their word with the PRE flag).
function createFader(registry, { addrs, merge, label }) {
  const cap = h('div', { class: 'fader-cap' }, h('i'));
  const track = h('div', { class: 'fader-track' }, h('div', { class: 'fader-slot' }), h('div', { class: 'fader-level' }), cap);
  const scale = h('div', { class: 'fader-scale', 'aria-hidden': 'true' },
    SCALE_MARKS.map((db) => h('span', { class: db === 0 ? 'is-unity' : '', style: { bottom: `${M.dbToPos(db) * 100}%` } }, db === 0 ? '0' : String(Math.abs(db)))));
  const el = h('div', { class: 'fader', role: 'slider', tabindex: '0', 'aria-label': label, 'aria-orientation': 'vertical' }, scale, track);

  const level = () => net.get(addrs[0]) & M.LEVEL_MASK;
  const write = (value) => net.set(addrs.map((a) => [a, merge ? merge(net.get(a), value) : value]));
  const update = () => {
    const pos = M.levelToPos(level());
    el.style.setProperty('--pos', pos.toFixed(4));
    el.setAttribute('aria-valuetext', formatDb(M.levelToDb(level()), true));
  };

  // Dragging is relative: touching the fader never makes the level jump.
  // A finger moving up or down moves the level; a finger moving sideways
  // scrolls the row of strips, which the browser does by itself (the fader
  // allows it with touch-action: pan-x) and tells us by cancelling the touch.
  // Nothing is changed until the finger has clearly set off up or down.
  const START = 7;
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    capture(el, e.pointerId);
    const travel = track.getBoundingClientRect().height - cap.getBoundingClientRect().height;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pos: M.levelToPos(level()), travel: Math.max(travel, 1), moving: e.pointerType === 'mouse' };
    if (drag.moving) {
      net.hold(addrs);
      el.classList.add('is-active');
      e.preventDefault();
    }
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moving) {
      const dx = Math.abs(e.clientX - drag.x), dy = Math.abs(e.clientY - drag.y);
      if (dy < START || dy < dx) return;
      // Off it goes, counted from here so that the level does not jump.
      drag.moving = true;
      drag.y = e.clientY;
      net.hold(addrs);
      el.classList.add('is-active');
      return;
    }
    // Holding Shift gives fine control.
    const gearing = e.shiftKey ? 0.25 : 1;
    const pos = M.clamp(drag.pos + ((drag.y - e.clientY) / drag.travel) * gearing, 0, 1);
    write(M.posToLevel(pos));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moving) net.release(addrs);
    drag = null;
    el.classList.remove('is-active');
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('lostpointercapture', end);

  const nudge = (deltaDb) => {
    const db = M.levelToDb(level());
    const next = db === -Infinity ? (deltaDb > 0 ? -60 : -Infinity) : db + deltaDb;
    write(next < -90 ? 0 : M.dbToLevel(Math.min(next, 10)));
  };
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    nudge(e.deltaY < 0 ? 0.5 : -0.5);
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = { ArrowUp: 0.5, ArrowDown: -0.5, PageUp: 3, PageDown: -3 }[e.key];
    if (!step) return;
    e.preventDefault();
    nudge(step);
  });

  registry.bind(addrs, update);
  return el;
}

// --- strip ---------------------------------------------------------------------
// mixId: 'main' or the id of the aux/fx mix shown on the faders.
// role:  'channel' (in the scrolling area), 'master' (pinned on the right)
//        or 'page' (beside a channel's settings).
// Right click, or a held touch, asks for the strip's menu. A finger resting
// on a fader is mixing, not asking for a menu, so faders are left out for touch.
const HOLD_TIME = 550;
function attachMenu(el, open) {
  let timer = null;
  let start = null;
  let opened = false;
  let touch = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', (e) => {
    opened = false;
    touch = e.pointerType !== 'mouse';
    if (!touch || e.target.closest('.fader')) return;
    start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => { timer = null; opened = true; open(start.x, start.y); }, HOLD_TIME);
  });
  el.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  });
  for (const name of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(name, cancel);
  // The tap that ends a held touch must not press the button under the finger.
  el.addEventListener('click', (e) => {
    if (!opened) return;
    opened = false;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (opened || (touch && e.target.closest('.fader'))) return;
    cancel();
    opened = touch;
    open(e.clientX, e.clientY);
  });
}

export function createStrip(strip, { registry, mixId, role, locked, onEdit, onMenu }) {
  const onSends = role === 'channel' && mixId !== 'main';
  // Effects are fed after the fader; only AUX sends can be switched to pre.
  const canPre = onSends && M.BY_ID[mixId].kind === 'aux';
  const color = stripColor(strip);
  const levelAddrs = onSends ? M.sendAddrs(strip, mixId) : M.addrs(strip, 'fader');
  const onAddrs = M.addrs(strip, 'on');
  const bind = (addrs, update) => registry.bind(addrs, update);

  const readout = h('div', { class: 'strip-read' });
  bind(levelAddrs, () => { readout.textContent = formatDb(M.levelToDb(net.get(levelAddrs[0]))); });

  const controls = h('div', { class: 'strip-ctl' });
  if (onSends) {
    const pre = h('button', { class: 'btn btn-pre', type: 'button', title: 'Pre or post fader' });
    pre.addEventListener('click', () => {
      const next = !(net.get(levelAddrs[0]) & M.FLAG_PRE);
      net.set(levelAddrs.map((a) => [a, (net.get(a) & M.LEVEL_MASK) | (next ? M.FLAG_PRE : 0)]));
    });
    bind(levelAddrs, () => {
      const isPre = Boolean(net.get(levelAddrs[0]) & M.FLAG_PRE);
      pre.textContent = isPre ? 'PRE' : 'POST';
      pre.classList.toggle('is-on', isPre);
    });
    // Mutes this source in this mix only; the channel itself is not touched.
    const mute = h('button', { class: 'btn btn-mute', type: 'button', title: 'Mute in this mix' }, 'MUTE');
    mute.addEventListener('click', () => setSendMuted(strip, mixId, !isSendMuted(strip, mixId)));
    bind(levelAddrs, () => mute.classList.toggle('is-on', isSendMuted(strip, mixId)));
    controls.append(canPre ? pre : h('div', { class: 'tag tag-post' }, 'POST'), mute);
  } else {
    const solo = h('button', { class: 'btn btn-solo', type: 'button' }, 'SOLO');
    const soloAddrs = M.soloPairs(strip, true).map(([a]) => a);
    solo.addEventListener('click', () => net.set(M.soloPairs(strip, !M.isSoloed(strip, net.get))));
    bind(soloAddrs, () => solo.classList.toggle('is-on', M.isSoloed(strip, net.get)));

    const mute = h('button', { class: 'btn btn-mute', type: 'button' }, 'MUTE');
    mute.addEventListener('click', () => {
      const muted = !net.get(onAddrs[0]);
      net.set(onAddrs.map((a) => [a, muted ? 1 : 0]));
    });
    bind(onAddrs, () => mute.classList.toggle('is-on', !net.get(onAddrs[0])));
    controls.append(solo, mute);
  }

  const flags = h('span', { class: 'strip-flags' });
  // In a mix, a channel muted on the mixer is silent here too: say so.
  if (onSends) {
    bind(onAddrs, () => flags.replaceChildren(...(net.get(onAddrs[0]) ? [] : [h('b', { class: 'flag-48' }, 'CH MUTED')])));
  }
  if (!onSends && strip.type === 'in') {
    const watch = [...M.addrs(strip, 'pan'), ...M.addrs(strip, 'phantom'), ...M.addrs(strip, 'phase')];
    bind(watch, () => {
      const parts = [];
      if (strip.phantom && net.get(M.addrs(strip, 'phantom')[0])) parts.push(h('b', { class: 'flag-48' }, '48V'));
      if (!net.get(M.addrs(strip, 'phase')[0])) parts.push(h('b', { class: 'flag-phase' }, 'Ø'));
      const pan = net.get(M.addrs(strip, 'pan')[0]);
      if (pan !== 100) parts.push(h('b', { class: 'flag-pan' }, formatPan(pan)));
      flags.replaceChildren(...parts);
    });
  }

  const merge = onSends ? (stored, value) => (stored & M.FLAG_PRE) | value : null;
  const canEdit = !locked && Boolean(onEdit);
  const name = h('button', { class: 'strip-name', type: 'button', disabled: !canEdit }, h('span', null, stripName(strip)));
  if (canEdit) name.addEventListener('click', () => onEdit(strip));

  const el = h('article', {
    class: `strip strip-${strip.kind}${role !== 'channel' ? ' is-master' : ''}${onSends ? ' is-send' : ''}`,
    data: { id: strip.id },
    vars: { '--c': color, '--ink': inkOn(color) },
  },
    h('header', { class: 'strip-head' }, h('span', { class: 'strip-id' }, strip.label), flags),
    controls,
    h('div', { class: 'strip-body' },
      createFader(registry, { addrs: levelAddrs, merge, label: `${stripName(strip)} level` }),
      createMeter(registry, strip.meters)),
    readout,
    name);
  // The whole strip shows when it is muted or soloed, not only the button.
  if (onSends) {
    bind(levelAddrs, () => el.classList.toggle('is-muted', isSendMuted(strip, mixId)));
  } else {
    bind(onAddrs, () => el.classList.toggle('is-muted', !net.get(onAddrs[0])));
    bind(M.soloPairs(strip, true).map(([a]) => a), () => el.classList.toggle('is-soloed', M.isSoloed(strip, net.get)));
  }
  if (onMenu && !locked) attachMenu(el, (x, y) => onMenu(strip, { x, y, onSends, levelAddrs }));
  return el;
}
