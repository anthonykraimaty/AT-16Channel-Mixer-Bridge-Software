// Watches a bridge from outside: is it answering, is the mixer connected,
// are meter frames arriving. One line every few seconds.
//   node tools/bridge-watch.js <address:port> <seconds>
const WebSocket = require('ws');

const target = process.argv[2] || '127.0.0.1:8600';
const seconds = Number(process.argv[3] || 60);
const t0 = Date.now();
let ws = null;
let frames = 0, ticks = 0, drops = 0;
let mixer = 'unknown';

function connect() {
  ws = new WebSocket(`ws://${target}/ws`, { handshakeTimeout: 3000 });
  ws.on('message', (d, bin) => {
    if (bin) { frames++; return; }
    const m = JSON.parse(d.toString());
    if (m.t === 'tick') ticks++;
    if (m.t === 'status') mixer = m.connected ? (m.synced ? 'in sync' : 'connected') : 'NOT connected';
  });
  ws.on('close', () => { drops++; ws = null; setTimeout(connect, 1000); });
  ws.on('error', () => {});
}
connect();

setInterval(() => {
  const open = ws && ws.readyState === WebSocket.OPEN;
  console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s  link ${open ? 'up  ' : 'DOWN'}  mixer ${mixer.padEnd(13)} beats ${String(ticks).padStart(2)}  meter frames ${String(frames).padStart(3)}  drops ${drops}`);
  frames = 0; ticks = 0;
}, 5000);
setTimeout(() => process.exit(0), seconds * 1000 + 200);
