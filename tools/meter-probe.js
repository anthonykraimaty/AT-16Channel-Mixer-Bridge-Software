// Finds which meter belongs to which output, and how output meters compare
// with input meters, using a signal that is already playing on one input.
//   node tools/meter-probe.js
// Sends PC/MP3 (pre-fader, at -10 dB) to one output at a time for a moment,
// records every meter, then puts all sends back as they were.
const WebSocket = require('ws');
const P = require('../server/protocol');

const host = '192.168.0.144';
const IN_L = 64 + 58 * 24, IN_R = 64 + 58 * 25; // PC/MP3 left and right blocks
const SENDS = { aux1: 9, aux2: 10, aux3: 11, aux4: 12, aux5: 13, aux6: 14, aux7: 15, aux8: 16, mainL: 17, mainR: 18, fx1: 21, fx2: 22 };
const LEVEL = 1100; // -10 dB
const PRE = 0x8000;
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

// Average level of every meter slot over a short time. Slot = (address - 2) * 2, high byte first.
async function measure(ms) {
  const sum = new Array(94).fill(0);
  let n = 0;
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await read(METERS);
    for (const a of METERS) {
      sum[(a - 2) * 2] += signed(v[a] >> 8);
      sum[(a - 2) * 2 + 1] += signed(v[a] & 0xff);
    }
    n++;
    await wait(40);
  }
  return sum.map((s) => s / n);
}

ws.on('open', async () => {
  const addrs = [];
  for (const off of Object.values(SENDS)) addrs.push(IN_L + off, IN_R + off);
  const original = await read(addrs);
  const silence = addrs.map((a) => [a, original[a] & 0xc000]);
  try {
    await write(silence);
    await wait(500);
    const floor = await measure(600);
    console.log(`input meters: L ${floor[24].toFixed(1)} dB (slot 24), R ${floor[25].toFixed(1)} dB (slot 25)`);
    for (const [name, off] of Object.entries(SENDS)) {
      for (const [side, block] of [['L', IN_L], ['R', IN_R]]) {
        await write([[block + off, PRE | LEVEL]]);
        await wait(450);
        const m = await measure(900);
        await write([[block + off, original[block + off] & 0xc000]]);
        const lit = [];
        for (let i = 26; i < 94; i++) if (m[i] - floor[i] > 6 && m[i] > -60) lit.push(`slot ${i}: ${m[i].toFixed(1)} dB`);
        const input = m[side === 'L' ? 24 : 25];
        console.log(`${side} -> ${name.padEnd(6)} input ${input.toFixed(1)} dB, expected ${(input - 10).toFixed(1)} dB   lit: ${lit.join(', ') || 'nothing'}`);
        await wait(250);
      }
    }
  } catch (e) {
    console.log('failed:', e.message);
  } finally {
    await write(addrs.map((a) => [a, original[a]])).catch(() => {});
    const after = await read(addrs).catch(() => ({}));
    const wrong = addrs.filter((a) => after[a] !== original[a]);
    console.log(wrong.length ? `NOT restored: ${wrong.join(', ')}` : 'all sends restored');
    ws.close();
    process.exit(0);
  }
});
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
