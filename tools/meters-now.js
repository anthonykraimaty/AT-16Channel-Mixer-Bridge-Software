// Is there sound on the mixer? Loudest meter reading over two seconds, read
// through the bridge. Run before anything that restarts the bridge.
//   node tools/meters-now.js
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8600/ws');
let loud = -128, frames = 0, status = null;
ws.on('message', (d, bin) => {
  if (!bin) { const m = JSON.parse(d.toString()); if (m.t === 'status') status = m; return; }
  frames++;
  for (const b of d) { const v = b > 127 ? b - 256 : b; if (v > loud && v < 30) loud = v; }
});
ws.on('error', (e) => { console.log('no bridge:', e.message); process.exit(1); });
setTimeout(() => { console.log(`mixer connected ${status && status.connected}, synced ${status && status.synced}, frames ${frames}, loudest ${loud} dB`); process.exit(0); }, 2200);
