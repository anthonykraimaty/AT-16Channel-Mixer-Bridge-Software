// Checks that fader levels survive a connection drop.
// Run with the bridge stopped (it must be the mixer's only client):
//   node tools/drop-test.js [millisecondsWithoutConnection]
// Sets CH2's fader, cuts the connection, reconnects and follows the level
// the mixer reports, ten times a second, until things are calm again.
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Mixer } = require('../server/mixer');
const { Memory } = require('../server/memory');
const P = require('../server/protocol');

const gap = Number(process.argv[2] || 5000);
const ADDR = 130; // CH2 fader
const TEST = 900; // -30 dB
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (emitter, event) => new Promise((r) => emitter.once(event, r));

(async () => {
  const memory = new Memory(path.join(os.tmpdir(), `drop-test-${Date.now()}.json`));
  const mixer = new Mixer({ host: '192.168.0.144', memory, resumeHours: 12 });
  let restored = null;
  mixer.on('restored', (n) => { restored = n; });
  mixer.start();
  await once(mixer, 'synced');
  // Let a fade left over from whoever was connected before run out.
  await wait(3000);
  const original = mixer.params[ADDR];
  mixer.set([[ADDR, TEST]]);
  await wait(800);
  console.log(`CH2 fader was ${original}, set to ${TEST}. Cutting the connection for ${gap}ms.`);

  mixer.stop();
  await wait(gap);
  const t0 = Date.now();
  mixer.start();

  // Watch the level from a second, independent connection.
  const seen = [];
  let lowest = TEST, highest = TEST;
  const probe = new WebSocket('ws://192.168.0.144:8088/', { perMessageDeflate: false });
  probe.on('message', (d) => {
    const m = P.decode(d);
    if (!m) return;
    if (m.fn === P.FN.PUSH) { probe.send(d); return; }
    if (m.fn !== P.FN.READ) return;
    const v = P.decodePairs(m.payload)[0][1];
    lowest = Math.min(lowest, v); highest = Math.max(highest, v);
    if (!seen.length || seen[seen.length - 1][1] !== v) seen.push([Date.now() - t0, v]);
  });
  await once(probe, 'open');
  const poll = setInterval(() => probe.send(P.encodeRead([ADDR])), 100);
  await wait(7000);
  clearInterval(poll);
  probe.terminate();

  const final = seen.length ? seen[seen.length - 1][1] : null;
  console.log(`level seen on the mixer after reconnecting (ms, value): ${JSON.stringify(seen)}`);
  console.log(`lowest ${lowest}, highest ${highest}, final ${final} -> ${final === TEST ? 'KEPT' : 'LOST'}; bridge reported ${restored === null ? 'nothing to put back' : `${restored} level(s) put back`}; resuming=${mixer.resuming}`);

  mixer.set([[ADDR, original]]);
  await wait(800);
  mixer.stop();
  await wait(200);
  process.exit(final === TEST ? 0 : 1);
})().catch((e) => { console.log('failed:', e.message); process.exit(1); });
