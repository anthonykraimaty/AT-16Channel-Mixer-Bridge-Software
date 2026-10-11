// The mixer reports three meters per input. This compares them on PC/MP3,
// which has a signal, and looks at what EQ and the gate do to each.
//   node tools/meter-banks.js
const WebSocket = require('ws');
const P = require('../server/protocol');

const host = '192.168.0.144';
const BLOCKS = [24, 25];
const base = (b) => 64 + 58 * b;
const METERS = Array.from({ length: 47 }, (_, i) => 2 + i);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (b) => (b > 127 ? b - 256 : b);

const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
let pending = null;
ws.on('message', (d) => {
  const m = P.decode(d);
  if (!m) return;
  if (m.fn === P.FN.PUSH) { ws.send(d); return; }
  if (pending && pending.fn === m.fn) { const p = pending; pending = null; p.resolve(m); }
});
const request = (frame, fn) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('timeout')), 3000);
  pending = { fn, resolve: (m) => { clearTimeout(t); resolve(m); } };
  ws.send(frame);
});
const read = async (addrs) => Object.fromEntries(P.decodePairs((await request(P.encodeRead(addrs), P.FN.READ)).payload));
const write = (pairs) => request(P.encodeWrite(pairs), P.FN.WRITE);

// Natural meter number n sits in address 2 + n/2: even numbers in the low byte.
const slot = (v, n) => { const word = v[2 + (n >> 1)]; return signed(n & 1 ? word >> 8 : word & 0xff); };

async function compare(label, ms) {
  const rows = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read(METERS);
    rows.push([slot(v, 24), slot(v, 26 + 24), slot(v, 52 + 24), slot(v, 25), slot(v, 26 + 25), slot(v, 52 + 25)]);
    await wait(40);
  }
  const mean = (i) => rows.reduce((s, r) => s + r[i], 0) / rows.length;
  const diff = (i, j) => { const d = rows.map((r) => r[i] - r[j]); const m = d.reduce((a, b) => a + b, 0) / d.length; const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / d.length); return `${m.toFixed(1)} (sd ${sd.toFixed(1)})`; };
  console.log(`${label.padEnd(26)} input ${mean(0).toFixed(1)}  second ${mean(1).toFixed(1)}  third ${mean(2).toFixed(1)}   second-input ${diff(1, 0)}  third-second ${diff(2, 1)}   [right: ${mean(3).toFixed(1)} ${mean(4).toFixed(1)} ${mean(5).toFixed(1)}]`);
}

ws.on('open', async () => {
  const addrs = BLOCKS.flatMap((b) => [base(b) + 2, base(b) + 3, base(b) + 4, base(b) + 25, base(b) + 26, base(b) + 29, base(b) + 32, base(b) + 44]);
  const original = await read(addrs);
  console.log('gate on/threshold, gain, comp on/ratio/threshold, eq on, band 2 gain:', BLOCKS.map((b) => [2, 3, 4, 25, 26, 29, 32, 44].map((o) => original[base(b) + o]).join(' ')).join(' | '));
  try {
    await compare('as it is', 3000);
    await write(BLOCKS.map((b) => [base(b) + 44, 620]));
    await wait(400);
    await compare('EQ band 2 at +12 dB', 2500);
    await write(BLOCKS.map((b) => [base(b) + 44, original[base(b) + 44]]));
    await write(BLOCKS.flatMap((b) => [[base(b) + 2, 1], [base(b) + 3, 0]]));
    await wait(400);
    await compare('gate closed (0 dB)', 2500);
    await write(BLOCKS.flatMap((b) => [[base(b) + 2, original[base(b) + 2]], [base(b) + 3, original[base(b) + 3]]]));
    await write(BLOCKS.flatMap((b) => [[base(b) + 25, 1], [base(b) + 26, 200], [base(b) + 29, 0x8000 | 400]]));
    await wait(400);
    await compare('compressor 20:1 at -40 dB', 2500);
  } catch (e) {
    console.log('failed:', e.message);
  } finally {
    await write(addrs.map((a) => [a, original[a]])).catch(() => {});
    const after = await read(addrs).catch(() => ({}));
    console.log(addrs.some((a) => after[a] !== original[a]) ? 'NOT fully restored' : 'all settings restored');
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
