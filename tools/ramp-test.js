// How long does the mixer keep pulling faders to their physical position
// after its last client has left?  Run with the bridge stopped.
//   node tools/ramp-test.js [reconnectDelayMs]
const WebSocket = require('ws');
const P = require('../server/protocol');

const host = '192.168.0.144';
const delay = Number(process.argv[2] || 50);
const ADDR = 130;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(onPush) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${host}:8088/`, { perMessageDeflate: false, origin: `http://${host}` });
    const c = { ws, pending: null };
    ws.on('message', (d) => {
      const m = P.decode(d);
      if (!m) return;
      if (m.fn === P.FN.PUSH) { ws.send(d); if (onPush) onPush(P.decodePairs(m.payload)); return; }
      if (c.pending && c.pending.fn === m.fn) { const p = c.pending; c.pending = null; p.resolve(m); }
    });
    c.request = (frame, fn) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout')), 3000);
      c.pending = { fn, resolve: (m) => { clearTimeout(t); res(m); } };
      ws.send(frame);
    });
    c.read = async () => P.decodePairs((await c.request(P.encodeRead([ADDR]), P.FN.READ)).payload)[0][1];
    c.write = (v) => c.request(P.encodeWrite([[ADDR, v]]), P.FN.WRITE);
    c.alive = setInterval(() => { if (ws.readyState === 1 && !c.pending) ws.send(P.encodeRead([2279])); }, 1000);
    c.close = () => { clearInterval(c.alive); ws.terminate(); };
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}

(async () => {
  // Start from a calm mixer: connect, wait for any ramp to finish.
  let a = await connect();
  await wait(6000);
  const original = await a.read();
  await a.write(900);
  await wait(500);
  console.log(`CH2 fader: was ${original}, set to 900, reads ${await a.read()}`);
  a.close();
  const cut = Date.now();
  console.log(`last client gone; reconnecting after ${delay}ms`);
  await wait(delay);

  let pushes = 0, first = 0, last = 0;
  const seen = [];
  const b = await connect((pairs) => {
    const t = Date.now() - cut;
    pushes++;
    if (!first) first = t;
    last = t;
    const v = pairs.find(([addr]) => addr === ADDR);
    if (v && (seen.length === 0 || seen[seen.length - 1][1] !== v[1])) seen.push([t, v[1]]);
  });
  console.log(`reconnected ${Date.now() - cut}ms after the cut`);
  await wait(9000);
  console.log(`announcements: ${pushes}, first at ${first}ms, last at ${last}ms after the cut`);
  console.log('CH2 fader as announced (ms after cut, value):', JSON.stringify(seen));
  console.log(`CH2 fader reads ${await b.read()}`);

  await b.write(900);
  pushes = 0; seen.length = 0;
  await wait(3000);
  console.log(`written again after the calm: reads ${await b.read()}, announcements since: ${pushes} ${JSON.stringify(seen)}`);

  await b.write(original);
  await wait(300);
  b.close();
  process.exit(0);
})().catch((e) => { console.log('failed:', e.message); process.exit(1); });
