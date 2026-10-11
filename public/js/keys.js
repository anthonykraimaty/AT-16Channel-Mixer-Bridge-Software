// Keyboard shortcuts of the main screen: choose a strip, then act on it.
//   1..9        channel 1..9            M            MAIN
//   1 then 0..6 channel 10..16, when pressed quickly one after the other
//   Ctrl+1..6   AUX 1..6                (again: the faders of that output)
//   Shift+1, 2  FX 1, 2                 (again: the sends to that effect)
//   Space       mute / unmute           S            solo (Shift: solo only this)
//   .           fader to 0 dB           Esc          nothing chosen
//   Numpad 0, - fader all the way down
//   R           name and colour         P            all sends of an AUX pre / post
//   Up, Down    fader up and down by 0.5 dB (Shift: 0.1, Page Up/Down: 3)
//   Shift+Space mute all channels, and again to bring back what was
//   Ctrl+A, I, O choose every strip on screen, the inputs, the outputs;
//               Ctrl+click adds or takes away one. Mute, solo and fader
//               keys then act on all of them at once.
//   ?           this list
import * as net from './net.js';
import { h, toast, openDialog, closeDialog } from './ui.js';
import { stripName, isSendMuted, setSendMuted, sendsPreState, setAllSendsPre } from './strips.js';
import { openChannel, openStrip } from './channel.js';

const M = window.MixerModel;
const $ = (id) => document.getElementById(id);

export const SHORTCUTS = [
  ['1 to 9', 'Choose channel 1 to 9'],
  ['1, then quickly 0 to 4', 'Choose channel 10 to 13/14'],
  ['M', 'Choose MAIN'],
  ['Ctrl + 1 to 6', 'Choose AUX 1 to 6. Pressed again: open its faders'],
  ['Shift + 1 or 2', 'Choose FX 1 or 2. Pressed again: open its sends'],
  ['Space', 'Mute or unmute what is chosen'],
  ['S', 'Solo what is chosen'],
  ['Shift + S', 'Solo what is chosen and nothing else'],
  ['. (full stop, or on the number pad)', 'Fader of what is chosen to 0 dB'],
  ['0 on the number pad, or -', 'Fader of what is chosen all the way down'],
  ['↑ and ↓', 'Fader up and down by 0.5 dB. Keep pressed to go on'],
  ['Shift + ↑ or ↓', 'The same in fine steps of 0.1 dB'],
  ['Page Up, Page Down', 'The same in steps of 3 dB'],
  ['R', 'Name and colour of what is chosen'],
  ['P', 'On the faders of an AUX: all sends pre-fader, again: all post'],
  ['Shift + Space', 'Mute all channels. Again: back to how it was'],
  ['Ctrl + A', 'Choose every strip on screen'],
  ['Ctrl + I', 'Choose the input channels on screen'],
  ['Ctrl + O', 'Choose the outputs on screen (AUX, MAIN)'],
  ['Ctrl + click', 'Add a strip to what is chosen, or take it away'],
  ['Esc', 'Nothing chosen'],
  ['?', 'This list'],
];

let host = null;
// The chosen strips, by id. Mute, solo and fader keys act on all of them.
let chosen = [];
let reveal = false;

const element = (id) => document.querySelector(`.console .strip[data-id="${id}"]`);

// Marks the chosen strip; called again whenever the strips are rebuilt.
export function paint() {
  for (const el of document.querySelectorAll('.console .strip.is-chosen')) el.classList.remove('is-chosen');
  for (const id of chosen) {
    const one = element(id);
    if (one) one.classList.add('is-chosen');
  }
  const el = chosen.length === 1 && element(chosen[0]);
  // Chosen before it was on screen: bring it into sight now that it is.
  if (el && reveal) {
    reveal = false;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  drawAllMuted();
}

export function choose(id, { show = true } = {}) {
  chosen = id ? [id] : [];
  const el = id && element(id);
  reveal = Boolean(id && show && !el);
  paint();
  if (el && show) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

// --- acting on the chosen strips -----------------------------------------------
// In a monitor mix the channels stand for their sends to that mix. Only
// strips on screen are acted on.
function targets() {
  // On the page of a channel the keys act on that channel's own fader.
  const page = onPage();
  if (page) return [{ strip: page, mix: 'main', onSends: false }];
  if (!chosen.length) {
    toast('Choose a channel first: 1 to 9, M for MAIN, Ctrl + 1 to 6 for an AUX, Shift + 1 or 2 for an effect, Ctrl + A for all.');
    return [];
  }
  const mix = host.mix();
  const list = chosen
    .filter((id) => M.BY_ID[id] && element(id))
    .map((id) => ({ strip: M.BY_ID[id], mix, onSends: mix !== 'main' && id !== mix }));
  if (!list.length) {
    const strip = M.BY_ID[chosen[0]];
    toast(chosen.length > 1 ? 'None of the chosen strips is on screen.' : `${strip ? stripName(strip) : 'That channel'} is not on screen.`);
  }
  return list;
}

const isMuted = (t) => (t.onSends ? isSendMuted(t.strip, t.mix) : !net.get(M.addrs(t.strip, 'on')[0]));

// With several chosen: if any still sounds all are muted, otherwise all unmuted.
function toggleMute() {
  const list = targets();
  if (!list.length) return;
  const mute = list.some((t) => !isMuted(t));
  const pairs = [];
  for (const t of list) {
    if (t.onSends) {
      if (isMuted(t) !== mute) setSendMuted(t.strip, t.mix, mute);
      continue;
    }
    for (const a of M.addrs(t.strip, 'on')) pairs.push([a, mute ? 0 : 1]);
  }
  if (pairs.length) net.set(pairs);
  if (list.length > 1) toast(`${list.length} strips ${mute ? 'muted' : 'unmuted'}.`);
}

function toggleSolo() {
  const list = targets().filter((t) => M.soloPairs(t.strip, true).length);
  if (!list.length) return;
  const on = list.some((t) => !M.isSoloed(t.strip, net.get));
  net.set(list.flatMap((t) => M.soloPairs(t.strip, on)));
  // A send strip has no solo lamp of its own.
  if (list.length > 1) toast(`${list.length} strips: solo ${on ? 'on' : 'off'}.`);
  else if (list[0].onSends) toast(`${stripName(list[0].strip)}: solo ${on ? 'on' : 'off'}.`);
}

// Solo the chosen strips and take solo off everything else, on screen or not.
function soloOnly() {
  const list = targets().filter((t) => M.has(t.strip, 'soloL'));
  if (!list.length) return;
  const keep = new Set(list.map((t) => t.strip.id));
  const pairs = [];
  for (const strip of M.STRIPS) {
    if (!M.has(strip, 'soloL')) continue;
    const on = keep.has(strip.id);
    if (on || M.isSoloed(strip, net.get)) pairs.push(...M.soloPairs(strip, on));
  }
  net.set(pairs);
  toast(list.length > 1 ? `Only these ${list.length} strips soloed.` : `Only ${stripName(list[0].strip)} soloed.`);
}

const levelAddrs = (t) => (t.onSends ? M.sendAddrs(t.strip, t.mix) : M.addrs(t.strip, 'fader'));
// Send levels share their word with the PRE flag.
const writeLevel = (t, a, level) => [a, t.onSends ? (net.get(a) & M.FLAG_PRE) | level : level];

// level: M.LEVEL_UNITY for 0 dB, 0 for fully down.
function faderTo(level) {
  const pairs = targets().flatMap((t) => levelAddrs(t).map((a) => writeLevel(t, a, level)));
  if (pairs.length) net.set(pairs);
}

// Up and down in decibels, the way the wheel and a focused fader do it. With
// several chosen, each fader moves by the same step from where it stands,
// and closed ones stay closed.
function nudge(deltaDb) {
  const pairs = [];
  const list = targets();
  for (const t of list) {
    const addrs = levelAddrs(t);
    if (!addrs.length) continue;
    const db = M.levelToDb(net.get(addrs[0]) & M.LEVEL_MASK);
    if (db === -Infinity && list.length > 1) continue;
    const next = db === -Infinity ? (deltaDb > 0 ? -60 : -Infinity) : Math.round((db + deltaDb) * 10) / 10;
    const level = next < -90 ? 0 : M.dbToLevel(Math.min(next, 10));
    for (const a of addrs) pairs.push(writeLevel(t, a, level));
  }
  if (pairs.length) net.set(pairs);
}

// Several strips at once, among those on screen.
const GROUPS = {
  a: { name: 'strips', test: () => true },
  i: { name: 'input channels', test: (s) => s.kind === 'input' },
  o: { name: 'outputs', test: (s) => s.kind === 'aux' || s.kind === 'main' },
};

function chooseGroup(key) {
  const group = GROUPS[key];
  const ids = [];
  for (const el of document.querySelectorAll('.console .strip[data-id]')) {
    const strip = M.BY_ID[el.dataset.id];
    if (strip && group.test(strip) && !ids.includes(strip.id)) ids.push(strip.id);
  }
  if (!ids.length) { toast(`No ${group.name} on screen.`); return; }
  chosen = ids;
  paint();
  toast(`${ids.length} ${group.name} chosen. Space mutes, the arrows move their faders, Esc lets go.`);
}

function toggleChosen(id) {
  chosen = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
  paint();
}

const STEPS = { ArrowUp: 0.5, ArrowDown: -0.5, PageUp: 3, PageDown: -3 };

function rename() {
  if (host.locked) return;
  const [t] = targets();
  if (t) host.rename(t.strip);
}

// --- mute all --------------------------------------------------------------------
// What was on before is kept by the bridge, so that any screen can bring it back.
const CHANNELS = M.STRIPS.filter((s) => s.kind === 'input' || s.kind === 'fx');
const kept = () => (net.state.meta.options || {}).muteAll || null;

export function toggleMuteAll() {
  if (host.locked || net.state.link !== 'ready') return;
  const before = kept();
  if (before && before.was) {
    const pairs = [];
    for (const strip of CHANNELS) {
      if (!(strip.id in before.was)) continue;
      for (const a of M.addrs(strip, 'on')) pairs.push([a, before.was[strip.id] ? 1 : 0]);
    }
    net.set(pairs);
    net.patchMeta(['options', 'muteAll'], null, { quiet: true });
    toast('Mutes are back to how they were.');
  } else {
    const was = {};
    const pairs = [];
    for (const strip of CHANNELS) {
      const addrs = M.addrs(strip, 'on');
      was[strip.id] = net.get(addrs[0]) ? 1 : 0;
      for (const a of addrs) pairs.push([a, 0]);
    }
    net.patchMeta(['options', 'muteAll'], { at: Date.now(), was }, { quiet: true });
    net.set(pairs);
    toast('All channels muted. Shift + Space brings back how it was.');
  }
  drawAllMuted();
}

function drawAllMuted() {
  const button = $('allMuted');
  if (button) button.hidden = !kept() || Boolean(host && host.locked);
}

// --- the list ----------------------------------------------------------------------
export function openShortcuts() {
  openDialog({
    label: 'Keyboard shortcuts',
    render(card) {
      card.append(
        h('header', { class: 'dialog-head' },
          h('div', { class: 'dialog-titles' }, h('small', null, 'KEYBOARD'), h('b', null, 'Shortcuts'))),
        h('div', { class: 'dialog-body' },
          h('dl', { class: 'keys' }, ...SHORTCUTS.flatMap(([keys, what]) => [h('dt', null, keys), h('dd', null, what)])),
          h('p', { class: 'hint' }, 'Inside the faders of an AUX, mute and fader act on the send of the chosen channel to that AUX.'),
          h('p', { class: 'hint' }, 'On the page of a channel the keys act on that channel, and choosing another strip turns to its page.')),
        h('footer', { class: 'dialog-foot' },
          h('button', { class: 'button button-primary', type: 'button', onclick: closeDialog }, 'Close')),
      );
    },
  });
}

// --- keys ------------------------------------------------------------------------
// Typing, a menu, a dialog or the settings of a channel come first.
function busy() {
  const at = document.activeElement;
  if (at && (['INPUT', 'TEXTAREA', 'SELECT'].includes(at.tagName) || at.isContentEditable)) return true;
  if (document.querySelector('.dialog-layer, .menu')) return true;
  return !$('sheet').hidden || !$('veil').hidden;
}

// The letter on the key, whatever writing the keyboard is set to.
function letterOf(e) {
  if (/^[a-z]$/i.test(e.key)) return e.key.toLowerCase();
  return /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : '';
}

// On a channel page, choosing a strip turns to its page instead.
const onPage = () => ($('page').hidden ? null : openStrip());

function turnPage(id) {
  openChannel(M.BY_ID[id]);
  choose(id, { show: false });
}

function output(id) {
  if (host.locked) return;
  const strip = M.BY_ID[id];
  if (!strip) return;
  if (onPage()) { turnPage(id); return; }
  // On screen and not chosen yet: choose it. Otherwise go to its faders.
  if (element(id) && !(chosen.length === 1 && chosen[0] === id)) { choose(id); return; }
  if (host.mix() !== id) host.selectMix(id);
  choose(id);
}

function channel(n) {
  // The stereo channel answers to all of its numbers.
  const id = n >= 13 ? 'ch13' : `ch${n}`;
  if (onPage()) { turnPage(id); return; }
  if (!element(id) && !host.show(id)) {
    toast(`${stripName(M.BY_ID[id])} is hidden in this mix.`);
    return;
  }
  choose(id);
}

// 1 and, quickly after it, another digit make a channel from 10 up.
const PAIR_TIME = 600;
let first = null;

function digits(n) {
  const now = performance.now();
  const paired = first && first.n === 1 && now - first.at < PAIR_TIME && n <= 6;
  first = paired || n === 0 ? null : { n, at: now };
  if (paired) channel(10 + n);
  else if (n > 0) channel(n);
  else return false;
  return true;
}

// On the faders of an AUX: every send pre fader, or all post if they already are.
function allPre() {
  const mix = M.BY_ID[host.mix()];
  if (host.locked || !mix || mix.kind !== 'aux') return false;
  const pre = sendsPreState(mix.id) !== 'pre';
  setAllSendsPre(mix.id, pre);
  toast(`All sends to ${stripName(mix)} are now ${pre ? 'pre' : 'post'}-fader.`);
  return true;
}

function press(e) {
  const digit = /^Digit([0-9])$/.exec(e.code);
  const n = digit ? Number(digit[1]) : null;
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && n >= 1 && n <= 6) {
    output(n >= 5 ? 'aux5' : `aux${n}`);
    return true;
  }
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && GROUPS[letterOf(e)]) {
    // A monitor link shows one mix only; there these stay the browser's own.
    if (host.locked || onPage()) return false;
    chooseGroup(letterOf(e));
    return true;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  if (digit) {
    if (!e.shiftKey) return digits(n);
    if (n === 1 || n === 2) output(`fx${n}`);
    else return false;
    return true;
  }
  first = null;
  if (STEPS[e.code]) {
    // A control of the page that has the focus takes the key itself.
    if (onPage() && document.activeElement && document.activeElement.closest('[role="slider"]')) return false;
    // Nothing chosen: a fader that has the focus takes the key itself.
    if (!onPage() && !chosen.some((id) => element(id))) return false;
    const fine = e.shiftKey && e.code.startsWith('Arrow');
    nudge(fine ? Math.sign(STEPS[e.code]) * 0.1 : STEPS[e.code]);
    return true;
  }
  if (e.code === 'Space') {
    if (e.shiftKey) toggleMuteAll(); else toggleMute();
    return true;
  }
  // A full stop on the number row or the number pad: 0 dB.
  if (e.code === 'NumpadDecimal' || (e.key === '.' && !e.shiftKey)) { faderTo(M.LEVEL_UNITY); return true; }
  // The 0 of the number row stays for channels 10 and up (1, then 0).
  if ((e.code === 'Numpad0' || e.code === 'NumpadSubtract' || e.key === '-') && !e.shiftKey) { faderTo(0); return true; }
  if (e.key === '?') { openShortcuts(); return true; }
  if (e.key === 'Escape') {
    // On a channel page Esc closes the page.
    if (onPage() || !chosen.length) return false;
    choose(null);
    return true;
  }
  if (e.shiftKey && letterOf(e) === 's') { soloOnly(); return true; }
  if (e.shiftKey) return false;
  const letter = letterOf(e);
  if (letter === 'm') { output('main'); return true; }
  if (letter === 's') { toggleSolo(); return true; }
  if (onPage()) return false;
  if (letter === 'r') { rename(); return true; }
  if (letter === 'p') return allPre();
  return false;
}

// host: { mix(), selectMix(id), show(id) -> bool, rename(strip), locked }
export function initKeys(options) {
  host = options;
  let held = null;
  document.addEventListener('keydown', (e) => {
    if (busy()) return;
    // Only the fader keys go on while they are kept pressed.
    const ours = e.repeat && !STEPS[e.code] ? e.code === held : press(e);
    if (!ours) return;
    held = e.code;
    // A button that was clicked keeps the focus and would take the Space too.
    e.preventDefault();
    e.stopPropagation();
    const at = document.activeElement;
    if (at && at.tagName === 'BUTTON') at.blur();
  }, true);
  document.addEventListener('keyup', (e) => {
    if (e.code !== held) return;
    held = null;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  // With a mouse, touching a strip chooses it as well.
  if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
    $('console').addEventListener('pointerdown', (e) => {
      const el = e.target.closest('.strip');
      if (!el) return;
      if (e.ctrlKey || e.metaKey) {
        // Only choosing: the fader or button under the pointer stays as it is.
        e.preventDefault();
        e.stopPropagation();
        toggleChosen(el.dataset.id);
        return;
      }
      // A strip among several chosen keeps them all, so its fader can be grabbed.
      if (!chosen.includes(el.dataset.id)) choose(el.dataset.id, { show: false });
    }, true);
    $('console').addEventListener('click', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.target.closest('.strip')) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }
  $('allMuted').addEventListener('click', toggleMuteAll);
  net.on('meta', drawAllMuted);
  drawAllMuted();
}
