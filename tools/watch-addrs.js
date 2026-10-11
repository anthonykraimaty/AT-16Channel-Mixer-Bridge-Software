// Logs every change of the given parameters, with a timestamp.
//   node tools/watch-addrs.js <seconds> <addr> [addr...]      (a-b for a range)
const WebSocket = require('ws');
const P = require('../server/protocol');

const [seconds, ...specs] = process.argv.slice(2);
const addrs = [];
for (const s of specs) {
  const [a, b] = s.split('-').map(Number);
  for (let x = a; x <= (b || a); x++) addrs.push(x);
}
const host = '192.168.0.144';
const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
const t0 = Date.now();
const last = new Map();
ws.on('open', () => {
  console.log(`watching ${addrs.length} parameters for ${seconds}s`);
  setInterval(() => { for (let i = 0; i < addrs.length; i += P.MAX_READ) ws.send(P.encodeRead(addrs.slice(i, i + P.MAX_READ))); }, 150);
});
ws.on('message', (d) => {
  const m = P.decode(d);
  if (!m) return;
  if (m.fn === P.FN.PUSH) { ws.send(d); return; }
  if (m.fn !== P.FN.READ) return;
  const changed = [];
  for (const [a, v] of P.decodePairs(m.payload)) {
    if (last.get(a) !== v) { if (last.has(a)) changed.push(`${a}: ${last.get(a)} -> ${v}`); last.set(a, v); }
  }
  if (changed.length) console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s  ${changed.join('   ')}`);
  else if (!ws.started) { ws.started = true; console.log('  start:', addrs.map((a) => `${a}=${last.get(a)}`).join(' ')); }
});
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
setTimeout(() => process.exit(0), Number(seconds) * 1000);
