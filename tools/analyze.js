// Analyze a capture session: verify checksum algorithm, build the parameter map,
// and list every non-read frame.
//   node tools/analyze.js [session.jsonl]
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'captures');
const file = process.argv[2] || fs.readdirSync(dir).filter((f) => f.startsWith('session-')).map((f) => path.join(dir, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const L = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
console.log('file', file, 'lines', L.length);

function crc16(buf, poly, init, refIn, refOut, xorOut) {
  let crc = init;
  for (const byte0 of buf) {
    let byte = byte0;
    if (refIn) { let r = 0; for (let i = 0; i < 8; i++) if (byte & (1 << i)) r |= 1 << (7 - i); byte = r; }
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ poly) & 0xffff : (crc << 1) & 0xffff;
  }
  if (refOut) { let r = 0; for (let i = 0; i < 16; i++) if (crc & (1 << i)) r |= 1 << (15 - i); crc = r; }
  return (crc ^ xorOut) & 0xffff;
}
const algos = {
  modbus: (b) => crc16(b, 0x8005, 0xffff, true, true, 0),
  arc: (b) => crc16(b, 0x8005, 0x0000, true, true, 0),
  ccittFalse: (b) => crc16(b, 0x1021, 0xffff, false, false, 0),
  xmodem: (b) => crc16(b, 0x1021, 0x0000, false, false, 0),
  kermit: (b) => crc16(b, 0x1021, 0x0000, true, true, 0),
  x25: (b) => crc16(b, 0x1021, 0xffff, true, true, 0xffff),
  usb: (b) => crc16(b, 0x8005, 0xffff, true, true, 0xffff),
};
const frames = L.filter((f) => f.dir).map((f) => ({ ...f, b: Buffer.from(f.hex, 'hex') }));
const sample = frames.slice(0, 50);
for (const [name, fn] of Object.entries(algos)) {
  for (const range of ['all', 'noHead', 'noHeadLen']) {
    for (const order of ['be', 'le']) {
      let ok = 0;
      for (const f of sample) {
        const body = f.b.slice(0, -2);
        const data = range === 'all' ? body : range === 'noHead' ? body.slice(1) : body.slice(2);
        const c = fn(data);
        const got = order === 'be' ? f.b.readUInt16BE(f.b.length - 2) : f.b.readUInt16LE(f.b.length - 2);
        if (c === got) ok++;
      }
      if (ok > 0) console.log(`CRC ${name} range=${range} order=${order}: ${ok}/${sample.length}`);
    }
  }
}

// length field check
let lenOk = 0;
for (const f of frames) if (f.b[1] === f.b.length - 2) lenOk++;
console.log(`length byte == total-2 : ${lenOk}/${frames.length}`);

// parameter map from read responses
const params = new Map();
const changes = [];
for (const f of frames) {
  if (f.dir !== 'rx' || f.b[2] !== 0x06) continue;
  const p = f.b.slice(3, -2);
  for (let i = 0; i + 3 < p.length; i += 4) {
    const a = p.readUInt16BE(i), v = p.readUInt16BE(i + 2);
    if (params.has(a) && params.get(a) !== v) changes.push({ t: f.t, a, from: params.get(a), to: v });
    params.set(a, v);
  }
}
const addrs = [...params.keys()].sort((a, b) => a - b);
console.log('distinct params read:', addrs.length, 'min', addrs[0], 'max', addrs[addrs.length - 1]);
fs.writeFileSync(path.join(dir, 'params.json'), JSON.stringify(Object.fromEntries(addrs.map((a) => [a, params.get(a)])), null, 0));

// which addresses changed over time (meters etc.)
const ch = {};
for (const c of changes) ch[c.a] = (ch[c.a] || 0) + 1;
console.log('addresses whose value changed during capture:', JSON.stringify(ch));

// everything that's not func 06 / 71
console.log('--- non-06 frames (deduped) ---');
const seen = new Set();
for (const f of frames) {
  if (f.b[2] === 0x06 || f.b[2] === 0x71) continue;
  const k = f.dir + f.hex;
  if (seen.has(k)) continue; seen.add(k);
  const ascii = [...f.b.slice(3, -2)].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
  console.log(String(f.t).padStart(6), f.dir, f.hex.replace(/(..)/g, '$1 ').trim(), ' |' + ascii + '|');
}

// polled address sets (tx 06) by frequency
console.log('--- tx read requests by frequency ---');
const req = {};
for (const f of frames) if (f.dir === 'tx' && f.b[2] === 0x06) req[f.hex] = (req[f.hex] || 0) + 1;
Object.entries(req).sort((a, b) => b[1] - a[1]).slice(0, 8).forEach(([h, n]) => {
  const p = Buffer.from(h, 'hex').slice(3, -2); const a = [];
  for (let i = 0; i + 1 < p.length; i += 2) a.push(p.readUInt16BE(i));
  console.log(String(n).padStart(5), `count=${a.length}`, a.slice(0, 70).join(','));
});
