// Compare the mixer's current parameters with a saved snapshot and optionally
// write the snapshot values back.
//   node tools/restore.js [snapshot.json]            (show differences)
//   node tools/restore.js [snapshot.json] --apply    (restore them)
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const P = require('../server/protocol');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const hostArg = args.find((a) => a.startsWith('--host='));
const host = hostArg ? hostArg.split('=')[1] : '192.168.0.144';
const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'captures', 'baseline-params.json');
const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
const addrs = Object.keys(snap).map(Number).sort((a, b) => a - b);
// Addresses 0..63 (meters) and 2269..2283 (device status) are live readings, not settings.
const isSetting = (a) => a >= 64 && (a < 2269 || a > 2283);

const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
let waiting = null;
const request = (frame, fn) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timeout')), 3000);
  waiting = { fn, resolve: (m) => { clearTimeout(timer); resolve(m); } };
  ws.send(frame);
});
ws.on('message', (d) => {
  const m = P.decode(d);
  if (m && waiting && m.fn === waiting.fn) { const w = waiting; waiting = null; w.resolve(m); }
});
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
ws.on('open', async () => {
  const diff = [];
  for (let i = 0; i < addrs.length; i += P.MAX_READ) {
    const m = await request(P.encodeRead(addrs.slice(i, i + P.MAX_READ)), P.FN.READ);
    for (const [a, v] of P.decodePairs(m.payload)) if (isSetting(a) && snap[a] !== v) diff.push([a, snap[a], v]);
  }
  if (!diff.length) console.log('mixer matches snapshot');
  for (const [a, want, have] of diff) console.log(`addr ${a}: snapshot ${want}  mixer ${have}`);
  if (apply && diff.length) {
    for (let i = 0; i < diff.length; i += P.MAX_WRITE) {
      await request(P.encodeWrite(diff.slice(i, i + P.MAX_WRITE).map(([a, want]) => [a, want])), P.FN.WRITE);
    }
    console.log(`restored ${diff.length} parameter(s)`);
  }
  ws.close();
  process.exit(0);
});
