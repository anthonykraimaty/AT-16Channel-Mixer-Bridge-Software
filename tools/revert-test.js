// What does the mixer do to values set over the network when the client that
// set them goes away?
//   node tools/revert-test.js [host] [--keep-observer]
// A writer connection changes a few CH2 parameters and disconnects; an
// observer connection stays and reports what the values do afterwards.
const WebSocket = require('ws');
const P = require('../server/protocol');

const host = process.argv.find((a, i) => i > 1 && !a.startsWith('--')) || '192.168.0.144';
const hard = process.argv.includes('--hard');

// CH2: gain, mute, pan, fader, send to AUX1, EQ band 1 gain. AUX2 fader. MAIN untouched.
const PROBES = { 126: 5, 128: 0, 129: 120, 130: 900, 131: 1000, 162: 520, 1620: 1100 };
const ADDRS = Object.keys(PROBES).map(Number);

function client(name) {
  const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
  const c = { name, ws, pending: null, pushes: [] };
  ws.on('message', (d) => {
    const m = P.decode(d);
    if (!m) return;
    if (m.fn === P.FN.PUSH) { ws.send(d); c.pushes.push(P.decodePairs(m.payload)); console.log(`  [${name}] push`, JSON.stringify(P.decodePairs(m.payload))); return; }
    if (c.pending && c.pending.fn === m.fn) { const p = c.pending; c.pending = null; p.resolve(m); }
  });
  ws.on('close', () => console.log(`  [${name}] closed`));
  ws.on('error', (e) => console.log(`  [${name}] error ${e.message}`));
  c.request = (frame, fn) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name}: timeout`)), 3000);
    c.pending = { fn, resolve: (m) => { clearTimeout(t); resolve(m); } };
    ws.send(frame);
  });
  c.read = async () => Object.fromEntries(P.decodePairs((await c.request(P.encodeRead(ADDRS), P.FN.READ)).payload));
  c.opened = new Promise((resolve) => ws.on('open', resolve));
  c.keepAlive = setInterval(() => { if (ws.readyState === 1 && !c.pending) ws.send(P.encodeRead([2279])); }, 1000);
  return c;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (label, v) => console.log(label.padEnd(34), ADDRS.map((a) => `${a}=${v[a]}`).join('  '));

(async () => {
  const observer = client('observer');
  await observer.opened;
  const before = await observer.read();
  show('before', before);

  const writer = client('writer');
  await writer.opened;
  await writer.request(P.encodeWrite(ADDRS.map((a) => [a, PROBES[a]])), P.FN.WRITE);
  await wait(1000);
  show('after write (writer connected)', await observer.read());

  clearInterval(writer.keepAlive);
  if (hard) writer.ws.terminate(); else writer.ws.close();
  console.log(`writer disconnected (${hard ? 'abruptly' : 'cleanly'})`);
  for (const s of [1, 3, 7, 12]) {
    await wait(s === 1 ? 1000 : s === 3 ? 2000 : s === 7 ? 4000 : 5000);
    show(`${s}s after writer left`, await observer.read());
  }

  // Put back whatever did not revert on its own.
  const now = await observer.read();
  const undo = ADDRS.filter((a) => now[a] !== before[a]).map((a) => [a, before[a]]);
  if (undo.length) await observer.request(P.encodeWrite(undo), P.FN.WRITE);
  show('restored', await observer.read());
  clearInterval(observer.keepAlive);
  observer.ws.close();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => { console.log('failed:', e.message); process.exit(1); });
