// Same question as revert-test.js, for the case where nobody stays connected:
// write, disconnect, wait, reconnect and look. Run with the bridge stopped.
//   node tools/revert-test-alone.js [gapSeconds] [--hard]
const WebSocket = require('ws');
const P = require('../server/protocol');

const host = '192.168.0.144';
const gap = Number(process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || 3);
const hard = process.argv.includes('--hard');
const PROBES = { 126: 5, 128: 0, 129: 120, 130: 900, 131: 1000, 143: 1000, 162: 520, 125: 60, 1620: 1100, 1622: 0, 2088: 900 };
const ADDRS = Object.keys(PROBES).map(Number);

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
    const c = { ws, pending: null };
    ws.on('message', (d) => {
      const m = P.decode(d);
      if (!m) return;
      if (m.fn === P.FN.PUSH) { ws.send(d); console.log('  push', JSON.stringify(P.decodePairs(m.payload))); return; }
      if (c.pending && c.pending.fn === m.fn) { const p = c.pending; c.pending = null; p.resolve(m); }
    });
    c.request = (frame, fn) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 3000);
      c.pending = { fn, resolve: (m) => { clearTimeout(t); res(m); } };
      ws.send(frame);
    });
    c.read = async () => Object.fromEntries(P.decodePairs((await c.request(P.encodeRead(ADDRS), P.FN.READ)).payload));
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (label, v) => console.log(label.padEnd(30), ADDRS.map((a) => `${a}=${v[a]}`).join(' '));

(async () => {
  let c = await connect();
  const before = await c.read();
  show('before', before);
  await c.request(P.encodeWrite(ADDRS.map((a) => [a, PROBES[a]])), P.FN.WRITE);
  show('after write', await c.read());
  if (hard) c.ws.terminate(); else c.ws.close();
  console.log(`disconnected ${hard ? 'abruptly' : 'cleanly'}, nobody connected for ${gap}s`);
  await wait(gap * 1000);
  c = await connect();
  const after = await c.read();
  show('after reconnect', after);
  console.log('reverted:', ADDRS.filter((a) => after[a] === before[a] && PROBES[a] !== before[a]).join(', ') || 'nothing');
  console.log('kept:    ', ADDRS.filter((a) => after[a] === PROBES[a] && PROBES[a] !== before[a]).join(', ') || 'nothing');
  const undo = ADDRS.filter((a) => after[a] !== before[a]).map((a) => [a, before[a]]);
  if (undo.length) await c.request(P.encodeWrite(undo), P.FN.WRITE);
  show('restored', await c.read());
  c.ws.close();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.log('failed:', e.message); process.exit(1); });
