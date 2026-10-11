// Channel page: everything about one strip on a single screen.
//   header   name, colour, previous / next channel
//   cards    input, EQ and filters, dynamics, sends
//   right    the strip itself (solo, mute, fader, meter), always in reach
import * as net from './net.js';
import { h, createScope, tile, paramSwitch, openDialog, closeDialog, formatDb, formatHz, formatPan, freqToUnit, unitToFreq } from './ui.js';
import { PALETTE, stripColor, stripName, inkOn, createStrip, createRegistry } from './strips.js';
import { createEqGraph } from './eqgraph.js';
import { createDynGraph } from './dyngraph.js';

const M = window.MixerModel;
const page = document.getElementById('page');

let open = null; // { strip, scope, registry, cleanup[] }

// Set by the main screen: shows the faders of a mix (an AUX, an FX, or MAIN).
let showMix = null;
export function onOpenMix(fn) {
  showMix = fn;
}

// --- value mappings ----------------------------------------------------------------
const linear = (min, max) => ({
  toUnit: (v) => (v - min) / (max - min),
  fromUnit: (u) => Math.round(min + u * (max - min)),
});
const logarithmic = (min, max) => ({
  toUnit: (v) => Math.log(Math.max(v, min) / min) / Math.log(max / min),
  fromUnit: (u) => Math.round(min * Math.pow(max / min, u)),
});
const stepRaw = (amount, [min, max]) => (v, dir) => M.clamp(v + dir * amount, min, max);
const formatMs = (v) => (v >= 10000 ? `${(v / 10000).toFixed(2)} s` : `${(v / 10).toFixed(v < 1000 ? 1 : 0)} ms`);

const FREQ = {
  toUnit: (v) => freqToUnit(M.decodeFreq(v)),
  fromUnit: (u) => M.encodeFreq(unitToFreq(u)),
  step: (v, dir) => {
    const hz = M.decodeFreq(v);
    const next = hz < 100 ? hz + dir * 0.5 : hz * (1 + dir * 0.01);
    return M.encodeFreq(M.clamp(hz < 100 ? next : Math.round(next) === Math.round(hz) ? hz + dir : next, 20, 20000));
  },
};
const LEVEL = {
  toUnit: (v) => M.levelToPos(v & M.LEVEL_MASK),
  fromUnit: (u) => M.posToLevel(u),
  step: (v, dir) => {
    const db = M.levelToDb(v);
    if (db === -Infinity) return dir > 0 ? M.dbToLevel(-60) : 0;
    const next = db + dir * 0.5;
    return next < -90 ? 0 : M.dbToLevel(Math.min(next, 10));
  },
  merge: (stored, level) => (stored & M.FLAG_PRE) | level,
  format: (v) => formatDb(M.levelToDb(v), true),
};

// --- cards -------------------------------------------------------------------------
const card = (kind, title, extras, ...body) => h('section', { class: `card card-${kind}`, data: { kind } },
  h('header', { class: 'card-head' }, h('h2', null, title), h('div', { class: 'card-tools' }, extras)),
  ...body);

function inputCard(scope, strip) {
  const tiles = [];
  const switches = [];
  if (M.has(strip, 'gain')) {
    tiles.push(tile(scope, { label: 'Gain', addrs: M.addrs(strip, 'gain'), ...linear(...M.RANGE.gain), step: stepRaw(1, M.RANGE.gain), format: (v) => `${v} dB` }));
  }
  if (M.has(strip, 'pan')) {
    tiles.push(tile(scope, { label: strip.blocks.length > 1 ? 'Balance' : 'Pan', addrs: M.addrs(strip, 'pan'), ...linear(0, 200), step: stepRaw(1, M.RANGE.pan), format: formatPan, origin: 0.5, reset: 100 }));
  }
  if (M.has(strip, 'delay') && M.RANGE.delay[1] > 0) {
    tiles.push(tile(scope, { label: 'Delay', addrs: M.addrs(strip, 'delay'), ...linear(...M.RANGE.delay), step: stepRaw(1, M.RANGE.delay), format: formatMs, reset: 0 }));
  }
  if (M.has(strip, 'fbc')) {
    tiles.push(tile(scope, {
      label: 'Feedback cut', addrs: M.addrs(strip, 'fbc'), ...linear(...M.RANGE.fbc), step: stepRaw(1, M.RANGE.fbc),
      format: (v) => (v === 0 ? 'Off' : `Level ${v}`), reset: 0,
    }));
  }
  if (strip.phantom) {
    switches.push(paramSwitch(scope, {
      label: '+48V', addrs: M.addrs(strip, 'phantom'), isOn: (v) => v === 1, write: (_s, on) => (on ? 1 : 0), tone: 'danger',
      confirm: `Turn on 48V phantom power for ${stripName(strip)}?`,
    }));
  }
  if (M.has(strip, 'phase')) {
    switches.push(paramSwitch(scope, { label: 'Phase Ø', addrs: M.addrs(strip, 'phase'), isOn: (v) => v === 0, write: (_s, on) => (on ? 0 : 1), tone: 'warn' }));
  }
  if (!tiles.length && !switches.length) return null;
  return card('input', strip.type === 'in' ? 'Input' : 'Output', switches, tiles.length ? h('div', { class: 'tiles' }, tiles) : null);
}

// Spectrum of the PC's sound card input (the mixer's USB sound card) behind
// the EQ curve. It shows what reaches the card, usually MAIN, not this channel
// alone: mute the others to see one channel. Remembered per device.
const RTA_KEY = 'mixer.rta';
const RTA_NOTES = {
  noDevice: 'RTA: choose the sound card in the menu',
  starting: 'RTA: starting',
  off: 'RTA: starting',
};

function rtaSwitch(graph) {
  let wanted = true;
  try { wanted = localStorage.getItem(RTA_KEY) !== 'off'; } catch { /* private mode */ }
  const button = h('button', { class: 'switch tone-accent', type: 'button', role: 'switch', title: 'Spectrum of the sound card input' }, h('i'), h('span', null, 'RTA'));
  let watching = false;

  const paint = () => {
    const info = net.state.rta || {};
    button.hidden = info.state === 'unsupported';
    button.classList.toggle('is-on', wanted);
    button.setAttribute('aria-checked', String(wanted));
    if (!wanted || info.state === 'unsupported') { graph.setSpectrum(null); return; }
    if (info.state === 'on') return;
    graph.setSpectrum(null, info.state === 'error' ? `RTA: ${info.message || 'sound card stopped'}` : RTA_NOTES[info.state] || '');
  };
  const watch = (on) => {
    if (on === watching) return;
    watching = on;
    net.watchRta(on);
  };
  const onFrame = (bands) => {
    const info = net.state.rta || {};
    if (wanted && Array.isArray(bands)) graph.setSpectrum({ bands, lowHz: info.lowHz || 20, perOctave: info.perOctave || 6 });
  };

  button.addEventListener('click', () => {
    wanted = !wanted;
    try { localStorage.setItem(RTA_KEY, wanted ? 'on' : 'off'); } catch { /* private mode */ }
    watch(wanted);
    paint();
  });
  net.on('rtaState', paint);
  net.on('rta', onFrame);
  watch(wanted);
  paint();
  return {
    el: button,
    close() {
      net.off('rtaState', paint);
      net.off('rta', onFrame);
      watch(false);
    },
  };
}

function eqCard(scope, strip) {
  const bands = M.OFFSET[strip.type].bands;
  const columns = h('div', { class: 'bands' });
  const chips = h('div', { class: 'band-chips' });
  const keys = ['hp', ...Array.from({ length: bands }, (_, i) => i), 'lp'];
  const labelOf = (key) => (key === 'hp' ? 'HPF' : key === 'lp' ? 'LPF' : `Band ${key + 1}`);
  const shortOf = (key) => (key === 'hp' ? 'HP' : key === 'lp' ? 'LP' : String(key + 1));

  const select = (key) => {
    graph.select(key);
    keys.forEach((k, i) => {
      chips.children[i].classList.toggle('is-on', k === key);
      columns.children[i].classList.toggle('is-on', k === key);
    });
  };
  const graph = createEqGraph(strip, { onSelect: select });

  const filterColumn = (key) => {
    const addrs = M.addrs(strip, key === 'hp' ? 'hpFreq' : 'lpFreq');
    const isOff = (v) => (key === 'hp' ? M.decodeFreq(v) < 20 : M.decodeFreq(v) > 20000);
    return [
      paramSwitch(scope, {
        label: 'On', addrs, isOn: (v) => !isOff(v),
        write: (_s, on) => (on ? M.encodeFreq(key === 'hp' ? 80 : 12000) : key === 'hp' ? M.HP_OFF : M.LP_OFF),
      }),
      tile(scope, { label: 'Freq', addrs, ...FREQ, compact: true, format: (v) => (isOff(v) ? 'Off' : formatHz(M.decodeFreq(v))) }),
      h('div', { class: 'band-note' }, '24 dB / oct'),
    ];
  };
  const bandColumn = (band) => [
    tile(scope, { label: 'Freq', addrs: M.eqAddrs(strip, band, 'freq'), ...FREQ, compact: true, format: (v) => formatHz(M.decodeFreq(v)) }),
    tile(scope, {
      label: 'Gain', addrs: M.eqAddrs(strip, band, 'gain'), ...linear(...M.RANGE.eqGain), step: stepRaw(1, M.RANGE.eqGain),
      compact: true, origin: 0.5, reset: 500, format: (v) => formatDb((v - 500) / 10, true),
    }),
    tile(scope, {
      label: 'Q', addrs: M.eqAddrs(strip, band, 'q'), ...logarithmic(...M.RANGE.eqQ),
      step: (v, dir) => M.clamp(v + dir * (v < 200 ? 5 : v < 1000 ? 20 : 100), ...M.RANGE.eqQ),
      compact: true, reset: 100, format: (v) => (v / 100).toFixed(2),
    }),
  ];

  for (const key of keys) {
    chips.append(h('button', { class: 'band-chip', type: 'button', onclick: () => select(key) }, shortOf(key)));
    columns.append(h('div', { class: 'band-col', onpointerdown: () => select(key) },
      h('div', { class: 'band-title' }, labelOf(key)),
      typeof key === 'number' ? bandColumn(key) : filterColumn(key)));
  }

  scope.watch(graph.watched, () => graph.draw());
  const tools = [
    h('button', {
      class: 'link', type: 'button',
      onclick: () => {
        const pairs = [];
        for (let b = 0; b < bands; b++) for (const a of M.eqAddrs(strip, b, 'gain')) pairs.push([a, 500]);
        net.set(pairs);
      },
    }, 'Flat'),
  ];
  if (M.has(strip, 'eqOn')) {
    tools.push(paramSwitch(scope, { label: 'EQ', addrs: M.addrs(strip, 'eqOn'), isOn: (v) => v === 1, write: (_s, on) => (on ? 1 : 0) }));
  }
  const rta = rtaSwitch(graph);
  if (rta) tools.unshift(rta.el);
  const el = card('eq', 'EQ & filters', tools, graph.el, chips, columns);
  columns.style.setProperty('--cols', keys.length);
  select(0);
  return { el, redraw: () => graph.draw(), close: () => rta && rta.close() };
}

function dynamicsCard(scope, strip) {
  if (!M.has(strip, 'compOn')) return null;
  const graph = createDynGraph(strip);
  scope.watch(graph.watched, () => graph.draw());
  const groups = [];

  if (M.has(strip, 'gateOn')) {
    groups.push(h('div', { class: 'dyn-group' },
      h('div', { class: 'dyn-head' }, h('h3', null, 'Gate'),
        paramSwitch(scope, { label: 'On', addrs: M.addrs(strip, 'gateOn'), isOn: (v) => v === 1, write: (_s, on) => (on ? 1 : 0) })),
      h('div', { class: 'tiles' },
        tile(scope, {
          label: 'Threshold', addrs: M.addrs(strip, 'gateThr'),
          toUnit: (v) => (120 - v) / 120, fromUnit: (u) => Math.round(120 - u * 120),
          step: (v, dir) => M.clamp(v - dir, ...M.RANGE.gateThr), format: (v) => (v === 0 ? '0 dB' : `-${v} dB`),
        }))));
  }

  const [thrMin, thrMax] = M.RANGE.compThr;
  groups.push(h('div', { class: 'dyn-group' },
    h('div', { class: 'dyn-head' }, h('h3', null, 'Compressor'),
      paramSwitch(scope, { label: 'On', addrs: M.addrs(strip, 'compOn'), isOn: (v) => v === 1, write: (_s, on) => (on ? 1 : 0) })),
    h('div', { class: 'tiles' },
      tile(scope, {
        label: 'Threshold', addrs: M.addrs(strip, 'compThr'),
        toUnit: (v) => (M.decodeSigned(v) - thrMin) / (thrMax - thrMin),
        fromUnit: (u) => M.encodeSigned(Math.round(thrMin + u * (thrMax - thrMin))),
        step: (v, dir) => M.encodeSigned(M.clamp(M.decodeSigned(v) + dir * 5, thrMin, thrMax)),
        format: (v) => formatDb(M.decodeSigned(v) / 10, true), reset: 0,
      }),
      tile(scope, {
        label: 'Ratio', addrs: M.addrs(strip, 'ratio'), ...logarithmic(...M.RANGE.ratio),
        step: (v, dir) => M.clamp(v + dir * (v < 50 ? 1 : 5), ...M.RANGE.ratio), format: (v) => `${(v / 10).toFixed(1)} : 1`, reset: 10,
      }),
      tile(scope, {
        label: 'Attack', addrs: M.addrs(strip, 'attack'), ...logarithmic(...M.RANGE.attack),
        step: (v, dir) => M.clamp(v + dir * (v < 200 ? 5 : v < 1000 ? 20 : 100), ...M.RANGE.attack), format: formatMs,
      }),
      tile(scope, {
        label: 'Release', addrs: M.addrs(strip, 'release'), ...logarithmic(...M.RANGE.release),
        step: (v, dir) => M.clamp(v + dir * (v < 1000 ? 50 : v < 10000 ? 200 : 1000), ...M.RANGE.release), format: formatMs,
      }))));

  const el = card('dyn', M.has(strip, 'gateOn') ? 'Gate & compressor' : 'Compressor', null,
    h('div', { class: 'dyn' }, graph.el, h('div', { class: 'dyn-groups' }, groups)));
  return { el, redraw: () => graph.draw() };
}

// The effect of an effects unit: which one, and its two settings.
function effectCard(scope, strip) {
  if (!M.has(strip, 'effect')) return null;
  const unit = strip.blocks[0];
  const typeAddr = M.addrs(strip, 'effect')[0];
  const current = () => M.effectOf(net.get(typeAddr));

  // The mixer brings back the settings it remembers for the chosen effect.
  const choose = (effect) => net.set([[M.FX_SELECT[unit], effect.number]]);
  const pick = () => openDialog({
    label: 'Choose the effect',
    render(dialog) {
      const now = current().number;
      dialog.style.setProperty('--c', stripColor(strip));
      dialog.append(
        h('header', { class: 'dialog-head' },
          h('div', { class: 'dialog-titles' }, h('small', null, strip.label), h('b', null, 'Effect'))),
        h('div', { class: 'dialog-body' },
          h('div', { class: 'effect-list' }, M.EFFECTS.map((effect) => h('button', {
            class: `effect-item${effect.number === now ? ' is-on' : ''}`, type: 'button',
            onclick: () => { choose(effect); closeDialog(); },
          }, h('small', null, String(effect.number)), h('span', null, effect.name))))),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'button', type: 'button', onclick: closeDialog }, 'Cancel')),
      );
    },
  });

  const name = h('span', { class: 'effect-name' });
  const button = h('button', { class: 'effect-button', type: 'button', onclick: pick },
    h('small', null, 'Effect'), name, h('i', { 'aria-hidden': 'true' }, '▾'));
  const tiles = h('div', { class: 'tiles' });
  let tileScope = null;

  // The two settings differ from effect to effect, so they are rebuilt with it.
  const rebuild = () => {
    const effect = current();
    name.textContent = effect.name;
    if (tileScope) tileScope.close();
    tileScope = createScope();
    tiles.replaceChildren(...effect.settings.map((setting, i) => {
      const [min, max] = setting.range;
      return tile(tileScope, {
        label: setting.label,
        addrs: M.addrs(strip, i ? 'fxB' : 'fxA'),
        ...linear(min, max), step: stepRaw(1, setting.range),
        format: (v) => `${(v * setting.scale).toFixed(setting.digits)}${setting.unit ? ` ${setting.unit}` : ''}`,
      });
    }));
  };
  scope.watch([typeAddr], rebuild);

  const el = card('effect', 'Effect', null, button, tiles);
  return { el, close: () => { if (tileScope) tileScope.close(); } };
}

function sendsCard(scope, strip) {
  if (!M.SEND[strip.type]) return null;
  const rows = [];
  for (const id of M.MIXES) {
    const mix = M.BY_ID[id];
    if (!M.isSource(strip, id)) continue;
    const addrs = M.sendAddrs(strip, id);
    if (!addrs.length) continue;
    const pre = mix.kind === 'aux' ? paramSwitch(scope, {
      label: 'Pre', addrs, isOn: (v) => Boolean(v & M.FLAG_PRE),
      write: (stored, on) => (stored & M.LEVEL_MASK) | (on ? M.FLAG_PRE : 0),
    }) : h('span', { class: 'send-spacer' });
    rows.push(h('div', { class: 'send', vars: { '--c': stripColor(mix) } },
      tile(scope, { label: stripName(mix), addrs, ...LEVEL, reset: M.LEVEL_UNITY }),
      pre));
  }
  // Level into the main mix, left and right. Stereo strips keep their own
  // left/right routing, so this is offered for mono inputs only.
  if (strip.type === 'in' && strip.blocks.length === 1) {
    for (const [name, label] of [['mainL', 'Main L'], ['mainR', 'Main R']]) {
      const addrs = [M.addr('in', strip.blocks[0], M.SEND.in[name])];
      rows.push(h('div', { class: 'send', vars: { '--c': stripColor(M.BY_ID.main) } },
        tile(scope, { label, addrs, ...LEVEL, reset: M.LEVEL_UNITY }),
        h('span', { class: 'send-spacer' })));
    }
  }
  return card('sends', 'Sends', null, h('div', { class: 'sends' }, rows));
}

// --- page --------------------------------------------------------------------------
function build(strip) {
  const scope = createScope();
  const registry = createRegistry();
  const cleanup = [() => scope.close(), () => registry.dispose()];
  const color = stripColor(strip);
  page.style.setProperty('--c', color);
  page.style.setProperty('--ink', inkOn(color));

  const name = h('input', {
    class: 'page-name', type: 'text', value: net.state.names[strip.nameSlots[0]] || '', placeholder: strip.label,
    maxLength: M.NAME_MAX_BYTES, autocomplete: 'off', spellcheck: false, enterKeyHint: 'done', 'aria-label': 'Name',
  });
  name.addEventListener('change', () => net.rename(strip.nameSlots, name.value.trim()));
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

  const swatches = h('div', { class: 'page-swatches', hidden: true });
  const paint = () => {
    const current = stripColor(strip);
    swatches.replaceChildren(
      ...PALETTE.map((c) => h('button', {
        class: `swatch${c === current ? ' is-on' : ''}`, type: 'button', vars: { '--c': c }, 'aria-label': `Colour ${c}`,
        onclick: () => net.patchMeta(['strips', strip.id], { ...(net.state.meta.strips[strip.id] || {}), color: c }),
      })),
      h('button', { class: 'link', type: 'button', onclick: () => net.patchMeta(['strips', strip.id], null) }, 'Default'));
  };
  paint();

  const index = M.STRIPS.indexOf(strip);
  const go = (delta) => show(M.STRIPS[(index + delta + M.STRIPS.length) % M.STRIPS.length]);

  // Outputs and effects have a mix of their own: one press leads to its faders.
  const mixId = strip.send ? strip.id : strip.kind === 'main' ? 'main' : null;
  const header = h('header', { class: 'page-head' },
    h('button', { class: 'page-btn page-back', type: 'button', 'aria-label': 'Back to mixer', onclick: () => history.back() }, '←'),
    h('div', { class: 'page-title' }, h('span', { class: 'page-id' }, strip.label), name),
    mixId && showMix ? h('button', {
      class: 'page-mix', type: 'button', title: `Show the faders of ${strip.label}`,
      onclick: () => { showMix(mixId); history.back(); },
    }, h('i', { class: 'dot' }), h('span', null, 'Faders')) : null,
    h('button', { class: 'page-btn page-color', type: 'button', 'aria-label': 'Colour', onclick: () => { swatches.hidden = !swatches.hidden; } }, h('i')),
    h('button', { class: 'page-btn', type: 'button', 'aria-label': 'Previous channel', onclick: () => go(-1) }, '‹'),
    h('button', { class: 'page-btn', type: 'button', 'aria-label': 'Next channel', onclick: () => go(1) }, '›'));

  const eq = eqCard(scope, strip);
  const dynamics = dynamicsCard(scope, strip);
  const effect = effectCard(scope, strip);
  if (effect) cleanup.push(effect.close);
  cleanup.push(eq.close);
  const cards = [effect && effect.el, inputCard(scope, strip), eq.el, dynamics && dynamics.el, sendsCard(scope, strip)].filter(Boolean);

  const side = createStrip(strip, { registry, mixId: 'main', role: 'page', locked: true });
  page.replaceChildren(header, swatches,
    h('div', { class: 'page-main' },
      h('div', { class: 'page-cards', data: { cards: cards.map((el) => el.dataset.kind).join(' ') } }, cards),
      h('aside', { class: 'page-strip' }, side)));

  const redraw = () => { eq.redraw(); if (dynamics) dynamics.redraw(); };
  window.addEventListener('resize', redraw);
  cleanup.push(() => window.removeEventListener('resize', redraw));
  requestAnimationFrame(redraw);

  return { strip, cleanup, name, paint, side };
}

function show(strip) {
  if (open) open.cleanup.forEach((fn) => fn());
  open = build(strip);
}

// The strip whose page is open, or null.
export function openStrip() {
  return open ? open.strip : null;
}

export function openChannel(strip) {
  const wasOpen = Boolean(open);
  show(strip);
  page.hidden = false;
  document.getElementById('app').classList.add('has-page');
  // The phone's back button closes the page instead of leaving the app.
  if (!wasOpen) history.pushState({ page: true }, '');
}

function close() {
  if (!open) return;
  open.cleanup.forEach((fn) => fn());
  open = null;
  page.hidden = true;
  page.replaceChildren();
  document.getElementById('app').classList.remove('has-page');
}

window.addEventListener('popstate', close);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open && document.getElementById('sheet').hidden && document.activeElement.tagName !== 'INPUT') history.back();
});

// Names and colours can change from another device while the page is open.
net.on('names', () => {
  if (!open || document.activeElement === open.name) return;
  open.name.value = net.state.names[open.strip.nameSlots[0]] || '';
});
net.on('meta', () => {
  if (!open) return;
  const color = stripColor(open.strip);
  page.style.setProperty('--c', color);
  page.style.setProperty('--ink', inkOn(color));
  open.side.style.setProperty('--c', color);
  open.side.style.setProperty('--ink', inkOn(color));
  open.paint();
});
