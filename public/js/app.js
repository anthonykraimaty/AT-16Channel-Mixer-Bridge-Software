// Main screen: mix selector, views and the row of strips.
import * as net from './net.js';
import { h, openSheet, closeSheet, openMenu, closeMenu, openDialog, closeDialog, toast, formatDb } from './ui.js';
import { createStrip, createRegistry, stripColor, defaultColor, stripName, inkOn, PALETTE, isSendMuted, setSendMuted, sendsPreState, setAllSendsPre } from './strips.js';
import { openChannel, onOpenMix } from './channel.js';
import { openSave, openLoad } from './configs.js';
import * as keys from './keys.js';

const M = window.MixerModel;
const $ = (id) => document.getElementById(id);

const query = new URLSearchParams(location.search);
const lockedMix = query.get('lock') !== null && M.MIXES.includes(query.get('mix')) ? query.get('mix') : null;

const prefs = {
  load(key, fallback) {
    try { return localStorage.getItem(`mixer.${key}`) ?? fallback; } catch { return fallback; }
  },
  save(key, value) {
    try { localStorage.setItem(`mixer.${key}`, value); } catch { /* private mode */ }
  },
};

const isMix = (id) => id === 'main' || M.MIXES.includes(id);
const ui = {
  mix: lockedMix || (isMix(query.get('mix')) ? query.get('mix') : prefs.load('mix', 'main')),
  view: prefs.load('view', 'all'),
  size: prefs.load('size', 'normal'),
};
if (!isMix(ui.mix)) ui.mix = 'main';

// --- views ---------------------------------------------------------------------
const BUILT_IN = [
  { id: 'all', name: 'All', strips: M.STRIPS.filter((s) => s.kind !== 'main').map((s) => s.id) },
  { id: 'inputs', name: 'Inputs', strips: M.STRIPS.filter((s) => s.kind === 'input' || s.kind === 'fx').map((s) => s.id) },
  { id: 'outputs', name: 'Outputs', strips: M.STRIPS.filter((s) => s.kind === 'aux').map((s) => s.id) },
];
const customViews = () => (Array.isArray(net.state.meta.views) ? net.state.meta.views : []);
const allViews = () => [...BUILT_IN, ...customViews()];
const currentView = () => allViews().find((v) => v.id === ui.view) || BUILT_IN[0];

// Strips shown in the scrolling area for the current mix and view.
function visibleStrips() {
  const ids = currentView().strips.filter((id) => M.BY_ID[id] && id !== 'main');
  if (ui.mix === 'main') return ids.map((id) => M.BY_ID[id]);
  const hidden = new Set((net.state.meta.mixes[ui.mix] || {}).hidden || []);
  let sources = ids.map((id) => M.BY_ID[id]).filter((s) => M.isSource(s, ui.mix));
  // A view without any source (such as Outputs) falls back to every source.
  if (!sources.length) sources = M.STRIPS.filter((s) => M.isSource(s, ui.mix));
  return sources.filter((s) => !hidden.has(s.id));
}

// --- rendering -----------------------------------------------------------------
const registry = createRegistry();
let renderQueued = false;
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    // Never rebuild under a finger that is moving a fader.
    if (document.querySelector('.console .fader.is-active')) { setTimeout(render, 250); return; }
    draw();
  });
}

function draw() {
  const app = $('app');
  const mixStrip = ui.mix === 'main' ? M.BY_ID.main : M.BY_ID[ui.mix];
  const mixColor = stripColor(mixStrip);
  app.dataset.mode = ui.mix === 'main' ? 'main' : 'sends';
  app.dataset.size = ui.size;
  app.classList.toggle('is-locked', Boolean(lockedMix));
  app.style.setProperty('--mix', mixColor);
  app.style.setProperty('--mix-ink', inkOn(mixColor));
  $('brandName').textContent = net.state.model || 'MIXER';

  drawMixChips();
  drawViewChips(mixStrip);

  const strips = $('strips');
  const scroll = strips.scrollLeft;
  registry.clear();
  closeMenu();
  const context = { registry, mixId: ui.mix, locked: Boolean(lockedMix), onEdit: openChannel, onMenu: openStripMenu };
  const list = visibleStrips();
  strips.replaceChildren(...list.map((s, i) => {
    const el = createStrip(s, { ...context, role: 'channel' });
    // A little air where inputs, effects and outputs meet.
    if (i > 0 && list[i - 1].kind !== s.kind) el.classList.add('starts-group');
    return el;
  }));
  if (!list.length) strips.append(h('div', { class: 'empty' }, 'No channels in this view.'));
  $('master').replaceChildren(createStrip(mixStrip, { ...context, role: 'master' }));
  strips.scrollLeft = scroll;
  keys.paint();
}

function chip(label, { on, color, onclick, extra = '' }) {
  return h('button', {
    class: `chip${on ? ' is-on' : ''} ${extra}`, type: 'button', onclick,
    vars: color ? { '--c': color, '--ink': inkOn(color) } : undefined,
  }, color ? h('i', { class: 'dot' }) : null, h('span', null, label));
}

function drawMixChips() {
  const box = $('mixChips');
  if (lockedMix) {
    box.replaceChildren(h('div', { class: 'locked-title' }, stripName(M.BY_ID[lockedMix])));
    return;
  }
  const ids = ['main', ...M.MIXES];
  box.replaceChildren(...ids.map((id) => {
    const strip = M.BY_ID[id];
    return chip(stripName(strip), { on: ui.mix === id, color: stripColor(strip), onclick: () => selectMix(id) });
  }));
}

function drawViewChips(mixStrip) {
  $('modeLabel').textContent = ui.mix === 'main' ? 'VIEW' : `SENDS TO ${stripName(mixStrip).toUpperCase()}`;
  const box = $('viewChips');
  const items = allViews().map((v) => chip(v.name, { on: currentView().id === v.id, onclick: () => selectView(v.id) }));
  if (!lockedMix) {
    const custom = customViews().some((v) => v.id === ui.view);
    if (custom) items.push(chip('Edit view', { extra: 'chip-action', onclick: () => openViewEditor(currentView()) }));
    items.push(chip('+ New view', { extra: 'chip-action', onclick: () => openViewEditor(null) }));
    if (ui.mix !== 'main') items.push(chip('Sources', { extra: 'chip-action', onclick: openSourcePicker }));
    if (mixStrip && mixStrip.kind === 'aux') {
      // Every send into this AUX pre or post fader in one press.
      const now = sendsPreState(ui.mix);
      items.push(chip('All pre', { on: now === 'pre', extra: 'chip-action chip-pre', onclick: () => setAllPre(ui.mix, true) }));
      items.push(chip('All post', { on: now === 'post', extra: 'chip-action chip-pre', onclick: () => setAllPre(ui.mix, false) }));
    }
  }
  box.replaceChildren(...items);
}

function setAllPre(mixId, pre) {
  setAllSendsPre(mixId, pre);
  render();
  toast(`All sends to ${stripName(M.BY_ID[mixId])} are now ${pre ? 'pre' : 'post'}-fader.`);
}

function selectMix(id) {
  ui.mix = id;
  prefs.save('mix', id);
  render();
}

function selectView(id) {
  ui.view = id;
  prefs.save('view', id);
  $('strips').scrollLeft = 0;
  render();
}

// --- strip menu ------------------------------------------------------------------
function openStripMenu(strip, { x, y, onSends, levelAddrs }) {
  const onAddrs = M.addrs(strip, 'on');
  const muted = !net.get(onAddrs[0]);
  const level = net.get(levelAddrs[0]);
  const mix = onSends ? M.BY_ID[ui.mix] : null;
  const setLevel = (value) => net.set(levelAddrs.map((a) => [a, onSends ? (net.get(a) & M.FLAG_PRE) | value : value]));

  const items = [
    { label: 'Rename and colour', run: () => openLabel(strip) },
    null,
    {
      label: onSends ? 'Send to 0 dB' : 'Fader to 0 dB',
      hint: `now ${formatDb(M.levelToDb(level), true)}`,
      run: () => setLevel(M.LEVEL_UNITY),
    },
    { label: onSends ? 'Send off' : 'Fader down', hint: '-∞', run: () => setLevel(0) },
  ];
  // Inside a monitor mix the channel's mute belongs to the main mix: leave it alone.
  if (!onSends) {
    items.push({
      label: muted ? 'Unmute' : 'Mute', tone: muted ? undefined : 'danger',
      run: () => net.set(onAddrs.map((a) => [a, muted ? 1 : 0])),
    });
  } else {
    const sendMuted = isSendMuted(strip, ui.mix);
    items.push({
      label: sendMuted ? 'Unmute in this mix' : 'Mute in this mix', tone: sendMuted ? undefined : 'danger',
      run: () => setSendMuted(strip, ui.mix, !sendMuted),
    });
  }
  items.push(null);
  if (!onSends && strip.send) items.push({ label: 'Show its faders', run: () => selectMix(strip.id) });
  items.push({ label: 'All settings', run: () => openChannel(strip) });

  openMenu({
    x, y, items, color: stripColor(strip), title: stripName(strip),
    subtitle: mix ? `${strip.label} · send to ${stripName(mix)}` : strip.label,
  });
}

// Name and colour of a strip. Nothing is changed until Done is pressed.
function openLabel(strip) {
  const saved = net.state.meta.strips[strip.id] || {};
  const draft = { name: net.state.names[strip.nameSlots[0]] || '', color: saved.color || null };

  openDialog({
    label: `Name and colour of ${strip.label}`,
    render(card) {
      const preview = h('div', { class: 'dialog-plate' }, h('span'));
      const input = h('input', {
        class: 'text-input', type: 'text', value: draft.name, placeholder: strip.label,
        maxLength: M.NAME_MAX_BYTES, autocomplete: 'off', spellcheck: false, enterKeyHint: 'done', 'aria-label': 'Name',
      });
      const swatches = h('div', { class: 'swatches' });

      const paint = () => {
        const color = draft.color || defaultColor(strip);
        card.style.setProperty('--c', color);
        card.style.setProperty('--ink', inkOn(color));
        preview.firstChild.textContent = draft.name.trim() || strip.label;
        swatches.replaceChildren(...PALETTE.map((c) => h('button', {
          class: `swatch${c === draft.color ? ' is-on' : ''}`, type: 'button', vars: { '--c': c }, 'aria-label': `Colour ${c}`,
          onclick: () => { draft.color = c; paint(); },
        })));
      };
      const done = () => {
        const name = draft.name.trim();
        if (name !== (net.state.names[strip.nameSlots[0]] || '')) net.rename(strip.nameSlots, name);
        if (draft.color !== (saved.color || null)) {
          const rest = { ...saved };
          delete rest.color;
          const value = draft.color ? { ...rest, color: draft.color } : rest;
          net.patchMeta(['strips', strip.id], Object.keys(value).length ? value : null);
        }
        closeDialog();
      };
      input.addEventListener('input', () => { draft.name = input.value; preview.firstChild.textContent = draft.name.trim() || strip.label; });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });

      card.append(
        h('header', { class: 'dialog-head' },
          h('div', { class: 'dialog-titles' }, h('small', null, strip.label), h('b', null, 'Name and colour')),
          preview),
        h('div', { class: 'dialog-body' },
          h('div', { class: 'group-title' }, 'Name'),
          input,
          h('div', { class: 'group-title' }, 'Colour'),
          swatches,
          h('button', { class: 'link', type: 'button', onclick: () => { draft.color = null; paint(); } }, 'Use default colour')),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'button', type: 'button', onclick: closeDialog }, 'Cancel'),
          h('button', { class: 'button button-primary', type: 'button', onclick: done }, 'Done')),
      );
      paint();
      // On a computer the name is what one came for; on a phone the keyboard
      // would cover the colours, so it opens only when the field is tapped.
      if (window.matchMedia('(pointer: fine)').matches) setTimeout(() => { input.focus(); input.select(); }, 0);
    },
  });
}

// --- view editor ---------------------------------------------------------------
function openViewEditor(view) {
  const isNew = !view;
  const draft = { id: view ? view.id : `v${Date.now().toString(36)}`, name: view ? view.name : '', strips: view ? [...view.strips] : [] };
  const candidates = M.STRIPS.filter((s) => s.kind !== 'main');

  openSheet({
    title: isNew ? 'New view' : 'Edit view',
    subtitle: 'Choose what this view shows, in order',
    render(body) {
      const name = h('input', { class: 'text-input', type: 'text', value: draft.name, placeholder: 'Drums, Vocals, Band...', maxLength: 24, autocomplete: 'off' });
      name.addEventListener('input', () => { draft.name = name.value; });
      const chosen = h('div', { class: 'pick-list' });
      const pool = h('div', { class: 'pick-pool' });

      const paint = () => {
        chosen.replaceChildren(...draft.strips.filter((id) => M.BY_ID[id]).map((id, i) => {
          const s = M.BY_ID[id];
          const move = (delta) => {
            const j = i + delta;
            if (j < 0 || j >= draft.strips.length) return;
            [draft.strips[i], draft.strips[j]] = [draft.strips[j], draft.strips[i]];
            paint();
          };
          return h('div', { class: 'pick-row', vars: { '--c': stripColor(s) } },
            h('i', { class: 'dot' }),
            h('span', { class: 'pick-name' }, stripName(s), h('small', null, s.label)),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move up', onclick: () => move(-1) }, '↑'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Move down', onclick: () => move(1) }, '↓'),
            h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Remove', onclick: () => { draft.strips.splice(i, 1); paint(); } }, '✕'));
        }));
        if (!draft.strips.length) chosen.append(h('p', { class: 'hint' }, 'Nothing chosen yet. Tap channels below to add them.'));
        pool.replaceChildren(...candidates.filter((s) => !draft.strips.includes(s.id)).map((s) => h('button', {
          class: 'chip', type: 'button', vars: { '--c': stripColor(s), '--ink': inkOn(stripColor(s)) },
          onclick: () => { draft.strips.push(s.id); paint(); },
        }, h('i', { class: 'dot' }), h('span', null, stripName(s)))));
      };
      paint();

      const save = () => {
        draft.name = draft.name.trim();
        if (!draft.name) { toast('Give the view a name.'); name.focus(); return; }
        if (!draft.strips.length) { toast('Add at least one channel.'); return; }
        const views = customViews().filter((v) => v.id !== draft.id);
        const at = customViews().findIndex((v) => v.id === draft.id);
        views.splice(at < 0 ? views.length : at, 0, draft);
        net.patchMeta(['views'], views);
        ui.view = draft.id;
        prefs.save('view', draft.id);
        closeSheet();
        render();
      };
      const remove = () => {
        if (!window.confirm(`Delete the view "${view.name}"?`)) return;
        net.patchMeta(['views'], customViews().filter((v) => v.id !== view.id));
        selectView('all');
        closeSheet();
      };

      body.append(
        h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Name'), name),
        h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'In this view'), chosen),
        h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Add'), pool),
        h('div', { class: 'actions' },
          isNew ? null : h('button', { class: 'button button-danger', type: 'button', onclick: remove }, 'Delete'),
          h('button', { class: 'button button-primary', type: 'button', onclick: save }, 'Save view')),
      );
    },
  });
}

// --- sources of a monitor mix ----------------------------------------------------
function openSourcePicker() {
  const mix = M.BY_ID[ui.mix];
  openSheet({
    title: `Sources for ${stripName(mix)}`,
    subtitle: 'Hide what this mix never needs',
    color: stripColor(mix),
    render(body) {
      const list = h('div', { class: 'pick-list' });
      const sources = M.STRIPS.filter((s) => M.isSource(s, mix.id));
      const levelOf = (s) => net.get(M.sendAddrs(s, mix.id)[0]) & M.LEVEL_MASK;
      const setSend = (s, level) => net.set(M.sendAddrs(s, mix.id).map((a) => [a, (net.get(a) & M.FLAG_PRE) | level]));

      // Hiding takes the source out of the mix; its level is kept for later.
      const toggle = (s) => {
        const saved = net.state.meta.mixes[mix.id] || {};
        const hidden = new Set(saved.hidden || []);
        const levels = { ...(saved.levels || {}) };
        if (hidden.has(s.id)) {
          hidden.delete(s.id);
          // Someone may have raised the send in the meantime: that level wins.
          if (levelOf(s) === 0 && levels[s.id]) setSend(s, levels[s.id]);
          delete levels[s.id];
        } else {
          hidden.add(s.id);
          if (levelOf(s) > 0) levels[s.id] = levelOf(s);
          setSend(s, 0);
        }
        net.patchMeta(['mixes', mix.id], { ...saved, hidden: [...hidden], levels });
        paint();
      };

      const paint = () => {
        const saved = net.state.meta.mixes[mix.id] || {};
        const hidden = new Set(saved.hidden || []);
        list.replaceChildren(...sources.map((s) => {
          const shown = !hidden.has(s.id);
          const level = levelOf(s);
          const kept = (saved.levels || {})[s.id];
          let state = 'Shown';
          let detail = level ? formatDb(M.levelToDb(level), true) : 'send off';
          if (!shown) {
            state = level ? 'Hidden, still on' : 'Hidden';
            detail = level ? formatDb(M.levelToDb(level), true) : kept ? `off, was ${formatDb(M.levelToDb(kept), true)}` : 'off';
          }
          return h('button', {
            class: `pick-row pick-toggle${shown ? ' is-on' : ''}${!shown && level ? ' is-leaking' : ''}`, type: 'button',
            vars: { '--c': stripColor(s) }, onclick: () => toggle(s),
          },
            h('i', { class: 'dot' }),
            h('span', { class: 'pick-name' }, stripName(s), h('small', null, `${s.label} · ${detail}`)),
            h('span', { class: 'pick-state' }, state));
        }));
      };
      const scope = { addrs: sources.map((s) => M.sendAddrs(s, mix.id)[0]) };
      const onParams = (changed) => { if (changed.some((a) => scope.addrs.includes(a))) paint(); };
      net.on('params', onParams);
      paint();
      body.append(
        h('div', { class: 'group' }, list),
        h('p', { class: 'hint' }, 'Hiding a source also turns its send to this mix off. Its level is remembered and comes back when you show it again.'),
      );
      return () => net.off('params', onParams);
    },
  });
}

// --- menu ------------------------------------------------------------------------
// The sound card whose input is shown as a spectrum on the channel pages.
// Only a bridge on Windows can record one.
function rtaGroup() {
  if ((net.state.rta || {}).state === 'unsupported') return null;
  const list = h('div', { class: 'rta-devices' }, h('p', { class: 'hint' }, 'Looking for sound cards...'));
  const fill = (names) => {
    const current = (net.state.meta.options || {}).rtaDevice || '';
    const pick = (name) => {
      net.patchMeta(['options', 'rtaDevice'], name || null);
      fill(shown);
    };
    shown = names;
    list.replaceChildren(
      ...['', ...names].map((name) => h('button', {
        class: `toggle${name === current ? ' is-on' : ''}`, type: 'button', title: name || 'No spectrum',
        onclick: () => pick(name),
      }, name || 'None')),
      ...(current && !names.includes(current) ? [h('p', { class: 'hint' }, `${current} is not connected now.`)] : []));
  };
  let shown = [];
  const onList = (names) => {
    if (!list.isConnected) { net.off('rtaDevices', onList); return; }
    fill(names);
  };
  net.on('rtaDevices', onList);
  net.listRtaDevices();
  return h('div', { class: 'group' },
    h('div', { class: 'group-title' }, 'Spectrum (RTA)'),
    h('p', { class: 'hint' }, 'Connect the mixer to this computer by USB and choose its sound card. The channel pages then show the spectrum of what the mixer sends to it, usually MAIN, behind the EQ curve. Mute the other channels to see one alone.'),
    list);
}

function openMainMenu() {
  if (lockedMix) return;
  openSheet({
    title: net.state.model || 'Mixer',
    subtitle: net.state.host ? `Connected through this bridge to ${net.state.host}` : '',
    render(body) {
      const sizes = h('div', { class: 'toggle-row' }, [['compact', 'Compact'], ['normal', 'Normal'], ['wide', 'Wide']].map(([id, label]) => h('button', {
        class: `toggle${ui.size === id ? ' is-on' : ''}`, type: 'button',
        onclick: (e) => {
          ui.size = id;
          prefs.save('size', id);
          [...e.target.parentNode.children].forEach((b) => b.classList.toggle('is-on', b === e.target));
          render();
        },
      }, label)));

      const links = h('div', { class: 'pick-list' }, M.MIXES.map((id) => {
        const s = M.BY_ID[id];
        const url = `${shareOrigin()}${location.pathname}?mix=${id}&lock`;
        return h('div', { class: 'pick-row', vars: { '--c': stripColor(s) } },
          h('i', { class: 'dot' }),
          h('span', { class: 'pick-name' }, stripName(s), h('small', null, url)),
          h('button', { class: 'icon-btn icon-btn-text', type: 'button', onclick: () => copy(url) }, 'Copy'),
          h('a', { class: 'icon-btn icon-btn-text', href: url, target: '_blank', rel: 'noopener' }, 'Open'));
      }));

      body.append(
        h('div', { class: 'group' }, h('div', { class: 'group-title' }, 'Strip width on this device'), sizes),
        h('div', { class: 'group' },
          h('div', { class: 'group-title' }, 'Mixer address'),
          h('div', { class: 'pick-row' },
            h('span', { class: 'pick-name' }, net.state.host || 'not set', h('small', null, net.state.link === 'ready' ? 'connected' : 'not connected')),
            h('button', { class: 'icon-btn icon-btn-text', type: 'button', onclick: () => { closeSheet(); openAddress(); } }, 'Change'))),
        h('div', { class: 'group' },
          h('div', { class: 'group-title' }, 'Connection drops'),
          h('p', { class: 'hint' }, 'The mixer\'s faders are not motorised. When it loses its network connection it falls back to where the faders physically stand. With this on, the levels set here are put back as soon as the connection returns.'),
          h('div', { class: 'toggle-row' }, h('button', {
            class: `toggle${(net.state.meta.options || {}).holdLevels !== false ? ' is-on' : ''}`, type: 'button',
            onclick: (e) => {
              const on = (net.state.meta.options || {}).holdLevels === false;
              net.patchMeta(['options', 'holdLevels'], on);
              e.target.classList.toggle('is-on', on);
              e.target.textContent = on ? 'Keeping fader levels' : 'Not keeping fader levels';
            },
          }, (net.state.meta.options || {}).holdLevels !== false ? 'Keeping fader levels' : 'Not keeping fader levels'))),
        h('div', { class: 'group' },
          h('div', { class: 'group-title' }, 'Personal monitor links'),
          h('p', { class: 'hint' }, 'A link opens one mix only: a musician can set their own monitor levels from a phone without reaching anything else.'),
          links),
        rtaGroup(),
        h('div', { class: 'group' },
          h('div', { class: 'group-title' }, 'Keyboard'),
          h('p', { class: 'hint' }, '1 to 9 choose a channel, Space mutes it, S solos it, the arrows move its fader. Press ? for the whole list.'),
          h('button', { class: 'button', type: 'button', onclick: () => { closeSheet(); keys.openShortcuts(); } }, 'Keyboard shortcuts')),
        h('div', { class: 'group' },
          h('div', { class: 'group-title' }, 'Original interface'),
          h('p', { class: 'hint' }, 'Scenes, the media player and system settings are in the mixer\'s own interface.'),
          h('a', { class: 'button', href: 'classic/', target: '_blank', rel: 'noopener' }, 'Open original interface')),
      );
    },
  });
}

// Links handed to other devices must not say "localhost".
function shareOrigin() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const bridge = net.state.bridge;
  if (local && bridge && bridge.address) return `http://${bridge.address}:${bridge.port}`;
  return location.origin;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied.');
  } catch {
    // Clipboard access needs HTTPS on most phones; show the link instead.
    window.prompt('Copy this link', text);
  }
}

// --- mixer address ---------------------------------------------------------------
function openAddress() {
  let unwatch = null;
  openDialog({
    label: 'Mixer address',
    onClose: () => { if (unwatch) unwatch(); },
    render(card) {
      const input = h('input', {
        class: 'text-input', type: 'text', value: net.state.host || '', placeholder: '192.168.0.144', maxLength: 253,
        autocomplete: 'off', spellcheck: false, inputMode: 'decimal', enterKeyHint: 'go', 'aria-label': 'Mixer address',
      });
      const connect = () => {
        const host = input.value.trim();
        if (!host) return;
        if (net.send({ t: 'mixerAddress', host })) closeDialog();
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); connect(); } });

      // Scan: the bridge looks through its network and reports what it finds.
      const scanButton = h('button', { class: 'button', type: 'button' }, 'Scan');
      const bar = h('i');
      const progress = h('div', { class: 'scan-bar', hidden: true }, bar);
      const note = h('p', { class: 'hint' }, 'Scan looks for the mixer on the network of the bridge.');
      const list = h('div', { class: 'pick-list' });
      let scanning = false;
      let found = [];
      const say = (text, tone) => {
        note.textContent = text;
        note.className = `hint${tone ? ` is-${tone}` : ''}`;
      };
      const mark = () => {
        for (const row of list.children) row.classList.toggle('is-chosen', row.dataset.address === input.value.trim());
      };
      const stop = () => {
        scanning = false;
        scanButton.disabled = false;
        progress.hidden = true;
      };
      const add = (entry) => {
        if (found.some((f) => f.address === entry.address)) return;
        found.push(entry);
        const current = entry.address === net.state.host;
        list.append(h('button', {
          class: 'pick-row scan-row', type: 'button', data: { address: entry.address },
          vars: { '--c': entry.sure ? 'var(--green)' : 'var(--amber)' },
          onclick: () => { input.value = entry.address; mark(); },
        },
        h('i', { class: 'dot' }),
        h('span', { class: 'pick-name' }, entry.address,
          h('small', null, entry.sure ? `${entry.model || 'Mixer'}${current ? ', in use now' : ''}` : 'Does not answer: connections all taken?'))));
        mark();
      };
      const onScan = (msg) => {
        if (!scanning) return;
        if (msg.state === 'network' && !found.length) say(`Searching ${msg.from} to ${msg.to}...`);
        else if (msg.state === 'progress') bar.style.width = `${Math.round((msg.done / Math.max(1, msg.total)) * 100)}%`;
        else if (msg.state === 'found') {
          add(msg);
          say(`Found ${found.length === 1 ? 'one' : found.length}. Still searching...`);
        } else if (msg.state === 'failed') {
          stop();
          say(`Could not search: ${msg.message}`, 'warning');
        } else if (msg.state === 'done') {
          stop();
          (msg.found || []).forEach(add);
          const sure = found.filter((f) => f.sure);
          if (!found.length) say('No mixer found. Is it switched on, and on the same network?', 'warning');
          else if (sure.length === 1) {
            // Only one mixer around: that must be it.
            input.value = sure[0].address;
            mark();
            say(sure[0].address === net.state.host ? 'Found the mixer, at the address in use now.' : 'Found the mixer. Its address is filled in.', 'good');
          } else say(`Found ${found.length}. Tap the one to use.`, 'good');
        }
      };
      scanButton.addEventListener('click', () => {
        if (scanning || !net.send({ t: 'scan' })) return;
        scanning = true;
        found = [];
        list.replaceChildren();
        bar.style.width = '0%';
        progress.hidden = false;
        scanButton.disabled = true;
        say('Searching...');
      });
      input.addEventListener('input', mark);
      net.on('scan', onScan);
      unwatch = () => net.off('scan', onScan);

      const auto = (net.state.meta.options || {}).autoFind !== false;
      const autoButton = h('button', {
        class: `toggle${auto ? ' is-on' : ''}`, type: 'button',
        onclick: () => {
          const on = (net.state.meta.options || {}).autoFind === false;
          net.patchMeta(['options', 'autoFind'], on);
          autoButton.classList.toggle('is-on', on);
          autoButton.textContent = on ? 'Finding the mixer by itself' : 'Not searching by itself';
        },
      }, auto ? 'Finding the mixer by itself' : 'Not searching by itself');

      card.append(
        h('header', { class: 'dialog-head' },
          h('div', { class: 'dialog-titles' }, h('small', null, 'CONNECTION'), h('b', null, 'Mixer address'))),
        h('div', { class: 'dialog-body' },
          h('div', { class: 'scan-line' }, input, scanButton),
          progress,
          note,
          list,
          h('div', { class: 'group-title' }, 'When the mixer does not answer'),
          h('p', { class: 'hint only-tall' }, 'The bridge can look for the mixer by itself and move to its new address, as long as it finds exactly one.'),
          h('div', { class: 'toggle-row' }, autoButton)),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'button', type: 'button', onclick: closeDialog }, 'Cancel'),
          h('button', { class: 'button button-primary', type: 'button', onclick: connect }, 'Connect')),
      );
      setTimeout(() => { input.focus(); input.select(); }, 0);
    },
  });
}

// --- connection state ----------------------------------------------------------
function drawLink() {
  const veil = $('veil');
  const messages = {
    connecting: ['Connecting', 'Reaching the bridge...'],
    offline: ['Bridge not reachable', 'The bridge program on the computer is not answering. Retrying...'],
    'mixer-offline': ['Mixer not reachable', `No answer from the mixer${net.state.host ? ` at ${net.state.host}` : ''}. Retrying...`],
    syncing: ['Reading mixer', 'Loading the current settings...'],
  };
  $('led').dataset.state = net.state.link;
  const message = messages[net.state.link];
  clearTimeout(veilTimer);
  if (!message) { veil.hidden = true; return; }
  $('veilTitle').textContent = message[0];
  $('veilText').textContent = message[1];
  $('veilAction').hidden = net.state.link !== 'mixer-offline' || Boolean(lockedMix);
  // A short interruption repairs itself: only say so when it lasts.
  if (net.state.loaded && veil.hidden) veilTimer = setTimeout(() => { veil.hidden = false; }, 1500);
  else veil.hidden = false;
}
let veilTimer = null;

net.on('link', drawLink);
net.on('status', drawLink);
net.on('reset', render);
net.on('meta', render);
// Pre/post set from a channel page or another screen: light the right chip.
net.on('params', () => {
  const mix = M.BY_ID[ui.mix];
  if (lockedMix || !mix || mix.kind !== 'aux') return;
  const lit = document.querySelector('.chip-pre.is-on');
  const now = sendsPreState(ui.mix);
  const shown = lit ? (lit.textContent === 'All pre' ? 'pre' : 'post') : 'mixed';
  if (now !== shown) drawViewChips(mix);
});
net.on('names', render);
net.on('error', (message) => toast(message));
net.on('notice', (notice) => {
  if (notice.kind === 'mixerFound') toast(`Found ${notice.model || 'the mixer'} at ${notice.address}.`);
  if (notice.kind === 'restored') toast(`Connection to the mixer is back. ${notice.count} fader level${notice.count === 1 ? ' was' : 's were'} put back.`);
});

onOpenMix(selectMix);
keys.initKeys({
  locked: Boolean(lockedMix),
  mix: () => ui.mix,
  selectMix,
  rename: openLabel,
  // Brings a channel on screen where that is possible.
  show(id) {
    const strip = M.BY_ID[id];
    if (!strip) return false;
    if (ui.mix !== 'main') {
      const hidden = (net.state.meta.mixes[ui.mix] || {}).hidden || [];
      if (!M.isSource(strip, ui.mix) || hidden.includes(id)) return false;
    }
    if (!visibleStrips().some((s) => s.id === id)) selectView('all');
    return true;
  },
});
$('veilAction').addEventListener('click', openAddress);
$('brand').addEventListener('click', openMainMenu);
$('saveConfig').addEventListener('click', openSave);
$('loadConfig').addEventListener('click', openLoad);

// Keep the screen awake while mixing, where the browser allows it.
async function stayAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') await navigator.wakeLock.request('screen');
  } catch { /* not granted */ }
}
document.addEventListener('visibilitychange', stayAwake);
stayAwake();

drawLink();
net.start();
