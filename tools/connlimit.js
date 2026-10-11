// How many clients does the mixer serve at once?
// Opens connections one after another; each keeps polling a parameter and
// reports whether it still gets answers.
//   node tools/connlimit.js [host] [count]
const WebSocket = require('ws');
const P = require('../server/protocol');

const host = process.argv[2] || '192.168.0.144';
const count = Number(process.argv[3] || 5);
const clients = [];

function open(i) {
  const c = { i, state: 'connecting', replies: 0, lastReply: 0 };
  clients.push(c);
  const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}`, handshakeTimeout: 4000 });
  c.ws = ws;
  ws.on('open', () => {
    c.state = 'open';
    c.timer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(P.encodeRead([2279])); }, 500);
  });
  ws.on('message', (d) => {
    const m = P.decode(d);
    if (m && m.fn === P.FN.READ) { c.replies++; c.lastReply = Date.now(); }
    if (m && m.fn === P.FN.PUSH) ws.send(d);
  });
  ws.on('close', (code) => { c.state = `closed(${code})`; clearInterval(c.timer); });
  ws.on('error', (e) => { c.state = `error(${e.message})`; });
}

let n = 0;
const step = setInterval(() => {
  if (n < count) open(++n);
  const now = Date.now();
  console.log(`t+${String(n).padStart(2)}: ` + clients.map((c) => `#${c.i} ${c.state} ${c.replies}${c.state === 'open' && now - c.lastReply > 1500 ? ' (silent)' : ''}`).join(' | '));
  if (n >= count && ++n > count + 3) {
    clearInterval(step);
    clients.forEach((c) => { try { c.ws.terminate(); } catch { /* closed */ } });
    setTimeout(() => process.exit(0), 300);
  }
}, 2000);
