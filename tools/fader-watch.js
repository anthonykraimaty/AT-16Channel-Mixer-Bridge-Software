// Watches what the mixer does while someone moves a physical fader.
//   node tools/fader-watch.js [seconds]
// Uses one mixer connection of its own, next to the bridge. Reports every
// announcement (function 25) that touches a fader, and every fader value
// that changed without being announced.
const WebSocket = require('ws');
const P = require('../server/protocol');
const M = require('../public/js/model');

const host = '192.168.0.144';
const seconds = Number(process.argv[2] || 180);
const ADDRS = M.HELD;
const nameOf = (a) => {
  const s = M.STRIPS.find((strip) => M.addrs(strip, 'fader').includes(a));
  return s ? s.label : `addr ${a}`;
};
const db = (v) => (v === 0 ? '-inf' : `${(v / 10 - 120).toFixed(1)} dB`);

const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const last = new Map();
const announced = new Map();
let announcements = 0, silentChanges = 0;

ws.on('open', () => {
  console.log(`watching ${ADDRS.length} faders for ${seconds}s`);
  setInterval(() => ws.send(P.encodeRead(ADDRS)), 200);
});
ws.on('message', (d) => {
  const m = P.decode(d);
  if (!m) return;
  if (m.fn === P.FN.PUSH) {
    ws.send(d);
    for (const [a, v] of P.decodePairs(m.payload)) {
      if (!ADDRS.includes(a) || announced.get(a) === v) continue;
      announced.set(a, v);
      announcements++;
      console.log(stamp(), `ANNOUNCED  ${nameOf(a).padEnd(8)} ${db(v)}`);
    }
    return;
  }
  if (m.fn !== P.FN.READ) return;
  for (const [a, v] of P.decodePairs(m.payload)) {
    const before = last.get(a);
    last.set(a, v);
    if (before === undefined || before === v) continue;
    if (announced.get(a) === v) continue;
    silentChanges++;
    console.log(stamp(), `CHANGED    ${nameOf(a).padEnd(8)} ${db(before)} -> ${db(v)} (not announced)`);
  }
});
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
setTimeout(() => {
  console.log(`done: ${announcements} announced change(s), ${silentChanges} unannounced change(s)`);
  process.exit(0);
}, seconds * 1000);
