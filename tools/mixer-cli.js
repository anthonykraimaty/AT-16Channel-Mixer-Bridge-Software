// Small command line client for experiments against the mixer.
//   node tools/mixer-cli.js read 130 131 132
//   node tools/mixer-cli.js range 66 58
//   node tools/mixer-cli.js write 130=0 129=100
//   node tools/mixer-cli.js raw 2e 00            (fn + payload bytes in hex)
//   node tools/mixer-cli.js dump out.json        (all parameters)
// Options: --host=192.168.0.144  --listen=2 (seconds to keep listening afterwards)
const fs = require('fs');
const WebSocket = require('ws');
const P = require('../server/protocol');

const args = process.argv.slice(2);
const opt = (name, def) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.split('=')[1] : def; };
const host = opt('host', '192.168.0.144');
const listen = Number(opt('listen', 1));
const total = Number(opt('total', 2607));
const pos = args.filter((a) => !a.startsWith('--'));
const cmd = pos.shift();

const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();
const waiters = [];
function request(frame, fn) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for fn ' + fn.toString(16))), 3000);
    waiters.push({ fn, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    ws.send(frame);
  });
}
ws.on('message', (d) => {
  const m = P.decode(d);
  if (!m) return console.log('rx (bad frame)', hex(d));
  const i = waiters.findIndex((w) => w.fn === m.fn);
  if (i !== -1) return waiters.splice(i, 1)[0].resolve(m);
  if (m.fn !== P.FN.STATUS || args.includes('--status')) console.log('rx unsolicited', hex(d));
});
ws.on('error', (e) => { console.log('error', e.message); process.exit(1); });
ws.on('open', async () => {
  try {
    if (cmd === 'read' || cmd === 'range') {
      let addrs = pos.map(Number);
      if (cmd === 'range') addrs = Array.from({ length: Number(pos[1]) }, (_, i) => Number(pos[0]) + i);
      for (let i = 0; i < addrs.length; i += P.MAX_READ) {
        const m = await request(P.encodeRead(addrs.slice(i, i + P.MAX_READ)), P.FN.READ);
        console.log(P.decodePairs(m.payload).map(([a, v]) => `${a}=${v}`).join(' '));
      }
    } else if (cmd === 'write') {
      const pairs = pos.map((s) => s.split('=').map(Number));
      const m = await request(P.encodeWrite(pairs), P.FN.WRITE);
      console.log('ack', P.decodePairs(m.payload).map(([a, v]) => `${a}=${v}`).join(' '));
    } else if (cmd === 'raw') {
      const bytes = pos.map((h) => parseInt(h, 16));
      const m = await request(P.encode(bytes[0], Buffer.from(bytes.slice(1))), bytes[0]);
      console.log('rx', hex(m.payload), ' |' + m.payload.toString('latin1').replace(/[^\x20-\x7e]/g, '.') + '|');
    } else if (cmd === 'dump') {
      const out = {};
      for (let a = 0; a < total; a += P.MAX_READ) {
        const addrs = Array.from({ length: Math.min(P.MAX_READ, total - a) }, (_, i) => a + i);
        const m = await request(P.encodeRead(addrs), P.FN.READ);
        for (const [k, v] of P.decodePairs(m.payload)) out[k] = v;
      }
      fs.writeFileSync(pos[0] || 'dump.json', JSON.stringify(out));
      console.log('dumped', Object.keys(out).length, 'parameters to', pos[0] || 'dump.json');
    } else {
      console.log('listening only');
    }
  } catch (e) { console.log('failed:', e.message); }
  setTimeout(() => { ws.close(); process.exit(0); }, listen * 1000);
});
