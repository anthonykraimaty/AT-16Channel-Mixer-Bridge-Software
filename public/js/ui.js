// Small DOM toolkit: element builder, sheet, toast and form controls.
import * as net from './net.js';

const M = window.MixerModel;

// Keeps pointer events coming to `el` while a drag lasts. Fails quietly when
// the pointer is already gone; the drag then simply ends early.
export function capture(el, pointerId) {
  try { el.setPointerCapture(pointerId); } catch { /* pointer no longer active */ }
}

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') Object.assign(el.style, value);
      else if (key === 'vars') for (const [k, v] of Object.entries(value)) el.style.setProperty(k, v);
      else if (key === 'data') Object.assign(el.dataset, value);
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key in el && key !== 'list') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

// --- formatting --------------------------------------------------------------
export function formatDb(db, withUnit = false) {
  if (db === -Infinity) return '-∞';
  const text = (db > 0 ? '+' : '') + db.toFixed(1);
  return withUnit ? `${text} dB` : text;
}

export function formatHz(hz) {
  if (hz >= 10000) return `${(hz / 1000).toFixed(1)} kHz`;
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  if (hz < 100) return `${hz.toFixed(1)} Hz`;
  return `${Math.round(hz)} Hz`;
}

export function formatPan(v) {
  if (v === 100) return 'C';
  return v < 100 ? `L${100 - v}` : `R${v - 100}`;
}

// --- toast -------------------------------------------------------------------
let toastTimer = null;
export function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// --- sheet -------------------------------------------------------------------
// One sheet at a time: a bottom sheet on phones, a side panel on wide screens.
let closeHook = null;

export function openSheet({ title, subtitle, color, tabs, render, onClose }) {
  closeSheet();
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('backdrop');
  const body = h('div', { class: 'sheet-body' });
  const tabBar = h('div', { class: 'sheet-tabs' });
  let cleanup = null;

  const show = (tab) => {
    if (cleanup) cleanup();
    body.replaceChildren();
    for (const b of tabBar.children) b.classList.toggle('is-on', b.dataset.tab === (tab && tab.id));
    cleanup = (tab ? tab.render(body) : render(body)) || null;
    body.scrollTop = 0;
  };

  if (tabs && tabs.length > 1) {
    for (const tab of tabs) tabBar.append(h('button', { class: 'sheet-tab', type: 'button', data: { tab: tab.id }, onclick: () => show(tab) }, tab.label));
  }

  sheet.replaceChildren(...[
    h('header', { class: 'sheet-head', vars: color ? { '--c': color } : undefined },
      h('div', { class: 'sheet-titles' },
        h('div', { class: 'sheet-title' }, title),
        subtitle ? h('div', { class: 'sheet-sub' }, subtitle) : null),
      h('button', { class: 'sheet-close', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '✕')),
    tabs && tabs.length > 1 ? tabBar : null,
    body,
  ].filter(Boolean));
  sheet.hidden = false;
  backdrop.hidden = false;
  // Reading a layout value makes the browser register the closed state, so
  // the opening transition runs without waiting for an animation frame.
  void sheet.offsetWidth;
  sheet.classList.add('is-open');
  backdrop.classList.add('is-open');
  show(tabs ? tabs[0] : null);

  closeHook = () => {
    if (cleanup) cleanup();
    if (onClose) onClose();
  };
  return { setTitle(text) { sheet.querySelector('.sheet-title').textContent = text; } };
}

export function closeSheet() {
  const sheet = document.getElementById('sheet');
  const backdrop = document.getElementById('backdrop');
  if (sheet.hidden) return;
  const hook = closeHook;
  closeHook = null;
  if (hook) hook();
  sheet.classList.remove('is-open');
  backdrop.classList.remove('is-open');
  sheet.hidden = true;
  backdrop.hidden = true;
  sheet.replaceChildren();
}

document.getElementById('backdrop').addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// --- dialog ------------------------------------------------------------------
// A small window in the middle of the screen, for one short task.
let closeDialogHook = null;

export function closeDialog() {
  if (closeDialogHook) closeDialogHook();
}

export function openDialog({ label, render, onClose }) {
  closeDialog();
  const card = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': label });
  const layer = h('div', { class: 'dialog-layer' }, card);
  render(card);
  document.body.append(layer);

  // Only a press that starts and ends on the backdrop closes the dialog, so
  // dragging a text selection out of the field does not.
  let pressedOutside = false;
  layer.addEventListener('pointerdown', (e) => { pressedOutside = e.target === layer; });
  layer.addEventListener('click', (e) => { if (pressedOutside && e.target === layer) closeDialog(); });
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDialog(); } };
  document.addEventListener('keydown', key, true);
  closeDialogHook = () => {
    closeDialogHook = null;
    document.removeEventListener('keydown', key, true);
    layer.remove();
    if (onClose) onClose();
  };
  return card;
}

// --- menu --------------------------------------------------------------------
// A small menu next to the pointer. items: [{ label, hint, tone, run }] or null
// for a divider.
let closeMenuHook = null;

export function closeMenu() {
  if (closeMenuHook) closeMenuHook();
}

export function openMenu({ x, y, title, subtitle, color, items }) {
  closeMenu();
  const menu = h('div', { class: 'menu', role: 'menu', vars: color ? { '--c': color } : undefined },
    h('div', { class: 'menu-head' }, h('b', null, title), subtitle ? h('span', null, subtitle) : null),
    items.map((item) => (item
      ? h('button', {
        class: `menu-item${item.tone ? ` tone-${item.tone}` : ''}`, type: 'button', role: 'menuitem',
        onclick: () => { closeMenu(); item.run(); },
      }, h('span', null, item.label), item.hint ? h('small', null, item.hint) : null)
      : h('hr'))));
  document.body.append(menu);

  // Keep it on screen, and above the finger rather than under it.
  const rect = menu.getBoundingClientRect();
  const left = M.clamp(x - 20, 8, window.innerWidth - rect.width - 8);
  const top = M.clamp(y - 24, 8, window.innerHeight - rect.height - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;

  const openedAt = performance.now();
  const outside = (e) => {
    // The touch that opened the menu is still ending.
    if (performance.now() - openedAt < 250) return;
    if (!menu.contains(e.target)) closeMenu();
  };
  const key = (e) => { if (e.key === 'Escape') closeMenu(); };
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('blur', closeMenu);
  closeMenuHook = () => {
    closeMenuHook = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('blur', closeMenu);
    menu.remove();
  };
}

// --- controls ----------------------------------------------------------------
// Parameter bindings that live as long as a sheet tab is shown.
export function createScope() {
  const watchers = [];
  const onParams = (changed) => {
    for (const w of watchers) if (w.addrs.some((a) => changed.includes(a))) w.update();
  };
  const onReset = () => watchers.forEach((w) => w.update());
  net.on('params', onParams);
  net.on('reset', onReset);
  return {
    watch(addrs, update) {
      watchers.push({ addrs, update });
      update();
    },
    close() {
      net.off('params', onParams);
      net.off('reset', onReset);
      watchers.length = 0;
    },
  };
}

// A labelled slider bound to one parameter (written to every address given).
//   toUi / fromUi convert between the stored value and the slider position.
export function paramSlider(scope, { label, addrs, min, max, step = 1, toUi = (v) => v, fromUi = (v) => v, format, merge, center }) {
  const input = h('input', { type: 'range', min, max, step, class: 'range' });
  const readout = h('span', { class: 'field-value' });
  const current = () => net.get(addrs[0]);
  const update = () => {
    input.value = toUi(current());
    readout.textContent = format(current());
    const span = max - min;
    input.style.setProperty('--fill', `${((Number(input.value) - min) / span) * 100}%`);
  };
  const write = () => {
    const value = fromUi(Number(input.value));
    net.set(addrs.map((a) => [a, merge ? merge(net.get(a), value) : value]));
  };
  input.addEventListener('pointerdown', () => net.hold(addrs));
  input.addEventListener('input', () => { net.hold(addrs); write(); update(); });
  input.addEventListener('change', () => net.release(addrs));
  const field = h('label', { class: 'field' },
    h('span', { class: 'field-head' },
      h('span', { class: 'field-label' }, label),
      center !== undefined ? h('button', { class: 'field-reset', type: 'button', onclick: (e) => { e.preventDefault(); net.set(addrs.map((a) => [a, merge ? merge(net.get(a), center) : center])); } }, 'reset') : null,
      readout),
    input);
  scope.watch(addrs, update);
  return field;
}

// A two-state button bound to a flag parameter.
export function paramToggle(scope, { label, addrs, isOn, write, tone = 'accent', confirm }) {
  const button = h('button', { class: `toggle tone-${tone}`, type: 'button' }, label);
  const update = () => button.classList.toggle('is-on', isOn(net.get(addrs[0])));
  button.addEventListener('click', () => {
    const next = !isOn(net.get(addrs[0]));
    if (next && confirm && !window.confirm(confirm)) return;
    net.set(addrs.map((a) => [a, write(net.get(a), next)]));
  });
  scope.watch(addrs, update);
  return button;
}

// Logarithmic frequency mapping for sliders and the EQ graph.
const F_MIN = 20, F_MAX = 20000;
export const freqToUnit = (hz) => Math.log(M.clamp(hz, F_MIN, F_MAX) / F_MIN) / Math.log(F_MAX / F_MIN);
export const unitToFreq = (u) => {
  const hz = F_MIN * Math.pow(F_MAX / F_MIN, M.clamp(u, 0, 1));
  // Round to three significant digits so values read cleanly.
  const digits = Math.pow(10, Math.floor(Math.log10(hz)) - 2);
  return Math.round(hz / digits) * digits;
};

// A compact value control: drag sideways to change, − / + for single steps.
//   toUnit / fromUnit map the stored value to a 0..1 position and back.
//   origin (0..1) is where the indicator bar starts, e.g. 0.5 for pan.
export function tile(scope, { label, addrs, toUnit, fromUnit, format, step, merge, reset, origin = 0, compact = false }) {
  const value = h('span', { class: 'tile-value' });
  const bar = h('i', { class: 'tile-bar' });
  const main = h('div', { class: 'tile-main' }, h('span', { class: 'tile-label' }, label), value);
  const minus = h('button', { class: 'tile-step', type: 'button', tabindex: '-1', 'aria-label': `${label} down` }, '−');
  const plus = h('button', { class: 'tile-step', type: 'button', tabindex: '-1', 'aria-label': `${label} up` }, '+');
  const el = h('div', { class: `tile${compact ? ' tile-compact' : ''}`, role: 'slider', tabindex: '0', 'aria-label': label },
    compact ? null : minus, main, compact ? null : plus, bar);

  const current = () => net.get(addrs[0]);
  const write = (v) => net.set(addrs.map((a) => [a, merge ? merge(net.get(a), v) : v]));
  const update = () => {
    const u = M.clamp(toUnit(current()), 0, 1);
    const text = format(current());
    value.textContent = text;
    el.setAttribute('aria-valuetext', text);
    const from = Math.min(u, origin), to = Math.max(u, origin);
    bar.style.left = `${from * 100}%`;
    bar.style.width = `${Math.max(to - from, 0.006) * 100}%`;
  };
  const stepBy = (dir) => {
    const v = current();
    let next = step ? step(v, dir) : fromUnit(M.clamp(toUnit(v) + dir * 0.01, 0, 1));
    // Make sure a step always lands on a different value.
    for (let k = 2; next === v && k < 40; k++) next = fromUnit(M.clamp(toUnit(v) + dir * 0.01 * k, 0, 1));
    write(next);
  };

  let drag = null;
  main.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    drag = { id: e.pointerId, x: e.clientX, u: M.clamp(toUnit(current()), 0, 1), moved: false };
    capture(main, e.pointerId);
  });
  main.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved) {
      if (Math.abs(dx) < 5) return;
      drag.moved = true;
      drag.x = e.clientX;
      net.hold(addrs);
      el.classList.add('is-active');
      return;
    }
    const gearing = e.shiftKey ? 0.2 : 1;
    write(fromUnit(M.clamp(drag.u + (dx / 300) * gearing, 0, 1)));
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) net.release(addrs);
    drag = null;
    el.classList.remove('is-active');
  };
  main.addEventListener('pointerup', end);
  main.addEventListener('pointercancel', end);
  if (reset !== undefined) main.addEventListener('dblclick', () => write(reset));

  // Holding a step button repeats.
  for (const [button, dir] of [[minus, -1], [plus, 1]]) {
    let timer = null;
    const stop = () => { clearTimeout(timer); clearInterval(timer); timer = null; };
    button.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stepBy(dir);
      timer = setTimeout(() => { timer = setInterval(() => stepBy(dir), 70); }, 420);
    });
    for (const name of ['pointerup', 'pointerleave', 'pointercancel']) button.addEventListener(name, stop);
  }
  el.addEventListener('keydown', (e) => {
    const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    stepBy(dir);
  });
  el.addEventListener('wheel', (e) => {
    if (document.activeElement !== el) return;
    e.preventDefault();
    stepBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  scope.watch(addrs, update);
  return el;
}

// An on/off switch bound to a flag parameter.
export function paramSwitch(scope, { label, addrs, isOn, write, tone = 'accent', confirm }) {
  const button = h('button', { class: `switch tone-${tone}`, type: 'button', role: 'switch' }, h('i'), h('span', null, label));
  const update = () => {
    const on = isOn(net.get(addrs[0]));
    button.classList.toggle('is-on', on);
    button.setAttribute('aria-checked', String(on));
  };
  button.addEventListener('click', () => {
    const next = !isOn(net.get(addrs[0]));
    if (next && confirm && !window.confirm(confirm)) return;
    net.set(addrs.map((a) => [a, write(net.get(a), next)]));
  });
  scope.watch(addrs, update);
  return button;
}
