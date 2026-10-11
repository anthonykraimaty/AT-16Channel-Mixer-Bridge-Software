// Passive listener: connects to the mixer's control WebSocket, sends nothing,
// and prints/records every frame the mixer pushes.
//   node tools/listen.js [host] [seconds]
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const host = process.argv[2] || '192.168.0.144';
const seconds = Number(process.argv[3] || 8);
const url = `ws://${host}:8088/`;
const ws = new WebSocket(url, { perMessageDeflate: false, origin: `http://${host}` });
const t0 = Date.now();
const frames = [];
const distinct = new Map();

ws.on('open', () => console.log(`OPEN ${url} +${Date.now() - t0}ms`));
ws.on('message', (data, isBinary) => {
  const hex = Buffer.from(data).toString('hex');
  frames.push({ t: Date.now() - t0, dir: 'rx', hex });
  distinct.set(hex, (distinct.get(hex) || 0) + 1);
});
ws.on('close', (code, reason) => { console.log(`CLOSE code=${code} reason=${reason} +${Date.now() - t0}ms`); finish(); });
ws.on('error', (e) => console.log('ERROR', e.message));

let finished = false;
function finish() {
  if (finished) return; finished = true;
  console.log(`frames=${frames.length} distinct=${distinct.size}`);
  const rows = [...distinct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60);
  for (const [hex, n] of rows) console.log(String(n).padStart(5), hex.replace(/(..)/g, '$1 ').trim());
  const out = path.join(__dirname, '..', 'captures', `listen-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(frames));
  console.log('saved', out);
  process.exit(0);
}
setTimeout(() => { try { ws.close(); } catch {} setTimeout(finish, 500); }, seconds * 1000);
