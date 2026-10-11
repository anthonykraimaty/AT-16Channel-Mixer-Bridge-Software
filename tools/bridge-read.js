// Reads parameters the way a browser would: from a bridge, not from the mixer.
// Useful when the mixer's three connections are taken.
//   node tools/bridge-read.js <address:port> <addr> [addr...]
const WebSocket = require('ws');

const [target, ...addrs] = process.argv.slice(2);
const ws = new WebSocket(`ws://${target}/ws`, { handshakeTimeout: 3000 });
ws.on('message', (d, bin) => {
  if (bin) return;
  const m = JSON.parse(d.toString());
  if (m.t !== 'state') return;
  console.log(addrs.map((a) => `${a}=${m.params[Number(a)]}`).join(' '));
  process.exit(0);
});
ws.on('error', (e) => { console.log(`bridge not reachable: ${e.message}`); process.exit(1); });
setTimeout(() => { console.log('no state received'); process.exit(1); }, 5000);
