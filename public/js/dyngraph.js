// Transfer curve of a channel's dynamics: what comes out for what goes in,
// with the gate and the compressor on the same plot.
import * as net from './net.js';
import { h } from './ui.js';
import { stripColor } from './strips.js';

const M = window.MixerModel;

const IN_MIN = -80, IN_MAX = 10;

export function createDynGraph(strip) {
  const canvas = h('canvas', { class: 'dyn-canvas' });
  const el = h('div', { class: 'dyn-graph' }, canvas);
  const first = (key) => M.addrs(strip, key)[0];
  const hasGate = M.has(strip, 'gateOn');

  const read = () => ({
    gateOn: hasGate && net.get(first('gateOn')) === 1,
    gateThr: hasGate ? -net.get(first('gateThr')) : -Infinity,
    compOn: net.get(first('compOn')) === 1,
    compThr: M.decodeSigned(net.get(first('compThr'))) / 10,
    ratio: Math.max(net.get(first('ratio')) / 10, 1),
  });

  function output(input, d) {
    if (d.gateOn && input < d.gateThr) return -Infinity;
    if (d.compOn && input > d.compThr) return d.compThr + (input - d.compThr) / d.ratio;
    return input;
  }

  function draw() {
    if (!el.isConnected) return;
    const rect = el.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const w = Math.max(rect.width, 120), hgt = Math.max(rect.height, 120);
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(hgt * ratio)) {
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(hgt * ratio);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const x = (db) => ((db - IN_MIN) / (IN_MAX - IN_MIN)) * w;
    const y = (db) => hgt - ((Math.max(db, IN_MIN) - IN_MIN) / (IN_MAX - IN_MIN)) * hgt;
    const d = read();
    const color = stripColor(strip);

    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.textBaseline = 'bottom';
    for (let db = -60; db <= 0; db += 20) {
      ctx.strokeStyle = db === 0 ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.moveTo(Math.round(x(db)) + 0.5, 0); ctx.lineTo(Math.round(x(db)) + 0.5, hgt); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, Math.round(y(db)) + 0.5); ctx.lineTo(w, Math.round(y(db)) + 0.5); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.32)';
      ctx.fillText(String(db), x(db) + 3, hgt - 2);
    }
    // Unity line for reference.
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.moveTo(x(IN_MIN), y(IN_MIN)); ctx.lineTo(x(IN_MAX), y(IN_MAX)); ctx.stroke();
    ctx.setLineDash([]);

    const points = [];
    for (let px = 0; px <= w; px += 1) {
      const input = IN_MIN + (px / w) * (IN_MAX - IN_MIN);
      const out = output(input, d);
      points.push([px, out === -Infinity ? hgt : y(out)]);
    }
    ctx.beginPath();
    points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.lineTo(w, hgt); ctx.lineTo(0, hgt); ctx.closePath();
    ctx.globalAlpha = 0.16; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath();
    points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();

    const mark = (db, label, active) => {
      if (db < IN_MIN || db > IN_MAX) return;
      ctx.globalAlpha = active ? 1 : 0.35;
      ctx.beginPath(); ctx.arc(x(db), y(db), 9, 0, Math.PI * 2);
      ctx.fillStyle = '#2a2e34'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = active ? '#f2efe8' : color; ctx.stroke();
      ctx.fillStyle = '#f2efe8'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 10px "Barlow Condensed", sans-serif';
      ctx.fillText(label, x(db), y(db) + 0.5);
      ctx.textAlign = 'start'; ctx.textBaseline = 'bottom';
      ctx.globalAlpha = 1;
    };
    if (hasGate) mark(d.gateThr, 'G', d.gateOn);
    mark(d.compThr, 'C', d.compOn);
  }

  const watched = ['gateOn', 'gateThr', 'compOn', 'compThr', 'ratio'].filter((k) => M.has(strip, k)).map(first);
  requestAnimationFrame(draw);
  return { el, draw, watched };
}
