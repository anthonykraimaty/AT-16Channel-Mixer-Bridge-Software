// EQ response curve with draggable handles for the filters and bands.
import * as net from './net.js';
import { h, capture, freqToUnit, unitToFreq } from './ui.js';
import { stripColor } from './strips.js';

const M = window.MixerModel;

const DB_RANGE = 15;
const SAMPLE_RATE = 48000;
const GRID_HZ = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const GRID_LABEL = { 20: '20', 100: '100', 1000: '1k', 10000: '10k' };
const GRAB_RADIUS = 34;
// The spectrum has a scale of its own: full scale at the top.
const RTA_TOP_DB = 0;
const RTA_BOTTOM_DB = -90;

// Gain in dB of a peaking filter at frequency f.
function peakDb(f, f0, gainDb, q) {
  if (gainDb === 0) return 0;
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / SAMPLE_RATE;
  const alpha = Math.sin(w0) / (2 * q);
  const cos = Math.cos(w0);
  const b = [1 + alpha * A, -2 * cos, 1 - alpha * A];
  const a = [1 + alpha / A, -2 * cos, 1 - alpha / A];
  const w = (2 * Math.PI * f) / SAMPLE_RATE;
  const mag = (c) => {
    const re = c[0] + c[1] * Math.cos(w) + c[2] * Math.cos(2 * w);
    const im = -(c[1] * Math.sin(w) + c[2] * Math.sin(2 * w));
    return re * re + im * im;
  };
  return 10 * Math.log10(mag(b) / mag(a));
}

// 24 dB/octave Butterworth slopes.
const highPassDb = (f, fc) => -10 * Math.log10(1 + Math.pow(fc / f, 8));
const lowPassDb = (f, fc) => -10 * Math.log10(1 + Math.pow(f / fc, 8));

// Handles are addressed by key: 'hp', 'lp' or the band number.
export function createEqGraph(strip, { onSelect }) {
  const canvas = h('canvas', { class: 'eq-canvas' });
  const el = h('div', { class: 'eq-graph' }, canvas);
  const bands = M.OFFSET[strip.type].bands;
  const hpAddrs = M.addrs(strip, 'hpFreq');
  const lpAddrs = M.addrs(strip, 'lpFreq');
  const eqOnAddrs = M.addrs(strip, 'eqOn');
  let selected = 0;
  // Levels per band from the sound card (see server/rta.js), and a line of
  // text for when there are none.
  let spectrum = null;
  let spectrumNote = '';

  const read = () => {
    const list = [];
    for (let b = 0; b < bands; b++) {
      list.push({
        freq: M.decodeFreq(net.get(M.eqAddrs(strip, b, 'freq')[0])),
        gain: (net.get(M.eqAddrs(strip, b, 'gain')[0]) - 500) / 10,
        q: Math.max(net.get(M.eqAddrs(strip, b, 'q')[0]) / 100, 0.1),
      });
    }
    return {
      list,
      hp: M.decodeFreq(net.get(hpAddrs[0])),
      lp: M.decodeFreq(net.get(lpAddrs[0])),
      on: eqOnAddrs.length ? net.get(eqOnAddrs[0]) === 1 : true,
    };
  };

  const size = () => {
    const rect = el.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(rect.width, 200), hgt = Math.max(rect.height, 120);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(hgt * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(hgt * ratio);
    }
    return { w, h: hgt, ratio };
  };

  const xOf = (hz, w) => freqToUnit(hz) * w;
  const yOf = (db, hgt) => hgt / 2 - (db / DB_RANGE) * (hgt / 2);
  // The unrounded inverse of freqToUnit, for plotting.
  const unitToFreqExact = (u) => 20 * Math.pow(1000, u);

  // Screen position of every handle. Switched-off filters park at the edges.
  function handles(eq, w, hgt) {
    const list = [{ key: 'hp', label: 'H', x: eq.hp >= 20 ? xOf(eq.hp, w) : 0, y: yOf(0, hgt), off: eq.hp < 20 }];
    eq.list.forEach((band, i) => list.push({ key: i, label: String(i + 1), x: xOf(band.freq, w), y: yOf(band.gain, hgt) }));
    list.push({ key: 'lp', label: 'L', x: eq.lp <= 20000 ? xOf(eq.lp, w) : w, y: yOf(0, hgt), off: eq.lp > 20000 });
    return list;
  }

  function draw() {
    if (!el.isConnected) return;
    const { w, h: hgt, ratio } = size();
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const eq = read();
    const color = eq.on ? stripColor(strip) : '#6d7782';

    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'start';
    for (const hz of GRID_HZ) {
      const x = Math.round(xOf(hz, w)) + 0.5;
      ctx.strokeStyle = GRID_LABEL[hz] ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, hgt); ctx.stroke();
      if (GRID_LABEL[hz]) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillText(GRID_LABEL[hz], x + 3, hgt - 2); }
    }
    for (const db of [-12, -6, 0, 6, 12]) {
      const y = Math.round(yOf(db, hgt)) + 0.5;
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      if (db !== 0) { ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.fillText((db > 0 ? '+' : '') + db, 3, y - 1); }
    }

    if (spectrum) drawSpectrum(ctx, w, hgt);
    if (spectrumNote) {
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.textAlign = 'end'; ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(spectrumNote, w - 6, 5);
      ctx.textAlign = 'start';
    }

    const points = [];
    for (let px = 0; px <= w; px += 2) {
      const f = unitToFreqExact(px / w);
      let db = 0;
      for (const band of eq.list) db += peakDb(f, band.freq, band.gain, band.q);
      if (eq.hp >= 20) db += highPassDb(f, eq.hp);
      if (eq.lp <= 20000) db += lowPassDb(f, eq.lp);
      points.push([px, yOf(Math.max(db, -DB_RANGE * 1.5), hgt)]);
    }
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.lineTo(w, hgt / 2); ctx.lineTo(0, hgt / 2); ctx.closePath();
    ctx.globalAlpha = eq.on ? 0.18 : 0.08; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
    ctx.setLineDash(eq.on ? [] : [5, 5]); ctx.stroke(); ctx.setLineDash([]);

    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = '600 11px "Barlow Condensed", sans-serif';
    for (const node of handles(eq, w, hgt)) {
      const on = node.key === selected;
      const x = M.clamp(node.x, 11, w - 11);
      ctx.globalAlpha = node.off ? 0.45 : 1;
      ctx.beginPath(); ctx.arc(x, node.y, on ? 12 : 10, 0, Math.PI * 2);
      ctx.fillStyle = on ? '#f2efe8' : '#2a2e34'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = on ? '#f2efe8' : color; ctx.stroke();
      ctx.fillStyle = on ? '#101114' : '#f2efe8';
      ctx.fillText(node.label, x, node.y + 0.5);
      ctx.globalAlpha = 1;
    }
  }

  function drawSpectrum(ctx, w, hgt) {
    const { bands, lowHz, perOctave } = spectrum;
    const yDb = (db) => hgt - ((M.clamp(db, RTA_BOTTOM_DB, RTA_TOP_DB) - RTA_BOTTOM_DB) / (RTA_TOP_DB - RTA_BOTTOM_DB)) * hgt;
    ctx.beginPath();
    ctx.moveTo(0, hgt);
    bands.forEach((db, i) => ctx.lineTo(xOf(lowHz * Math.pow(2, i / perOctave), w), yDb(db)));
    ctx.lineTo(w, hgt);
    ctx.closePath();
    ctx.fillStyle = 'rgba(160,200,255,0.16)';
    ctx.fill();
    ctx.beginPath();
    bands.forEach((db, i) => {
      const x = xOf(lowHz * Math.pow(2, i / perOctave), w);
      if (i) ctx.lineTo(x, yDb(db)); else ctx.moveTo(x, yDb(db));
    });
    ctx.strokeStyle = 'rgba(160,200,255,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Drag a handle: left/right for frequency, up/down for gain.
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    let best = null, bestDist = GRAB_RADIUS;
    for (const node of handles(read(), rect.width, rect.height)) {
      const d = Math.hypot(M.clamp(node.x, 11, rect.width - 11) - x, node.y - y);
      // Bands win over a filter handle sitting underneath them.
      if (d < bestDist || (d === bestDist && typeof node.key === 'number')) { best = node; bestDist = d; }
    }
    if (!best) return;
    e.preventDefault();
    capture(canvas, e.pointerId);
    const addrs = best.key === 'hp' ? hpAddrs : best.key === 'lp' ? lpAddrs
      : [...M.eqAddrs(strip, best.key, 'freq'), ...M.eqAddrs(strip, best.key, 'gain')];
    drag = { id: e.pointerId, key: best.key, addrs, dx: M.clamp(best.x, 11, rect.width - 11) - x, dy: best.y - y, moved: false };
    net.hold(addrs);
    onSelect(best.key);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left + drag.dx, y = e.clientY - rect.top + drag.dy;
    const hz = unitToFreq(x / rect.width);
    if (drag.key === 'hp' || drag.key === 'lp') {
      net.set(drag.addrs.map((a) => [a, M.encodeFreq(hz)]));
      return;
    }
    const db = M.clamp(((rect.height / 2 - y) / (rect.height / 2)) * DB_RANGE, -12, 12);
    const pairs = [];
    for (const a of M.eqAddrs(strip, drag.key, 'freq')) pairs.push([a, M.encodeFreq(hz)]);
    for (const a of M.eqAddrs(strip, drag.key, 'gain')) pairs.push([a, 500 + Math.round(db * 10)]);
    net.set(pairs);
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    net.release(drag.addrs);
    drag = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  const watched = [...hpAddrs, ...lpAddrs, ...eqOnAddrs];
  for (let b = 0; b < bands; b++) for (const f of ['freq', 'gain', 'q']) watched.push(M.eqAddrs(strip, b, f)[0]);

  requestAnimationFrame(draw);
  return {
    el,
    draw,
    watched,
    select(key) { selected = key; draw(); },
    // bands: levels in dB from lowHz up, perOctave bands an octave; null hides it.
    setSpectrum(next, note = '') {
      spectrum = next;
      spectrumNote = note;
      draw();
    },
  };
}
