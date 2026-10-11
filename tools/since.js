// Show frames recorded after a given marker, hiding the routine meter/status polling.
//   node tools/since.js <marker> [session.jsonl] [--all]
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'captures');
const marker = process.argv[2];
const showAll = process.argv.includes('--all');
const fileArg = process.argv.slice(3).find((a) => !a.startsWith('--'));
const file = fileArg || fs.readdirSync(dir).filter((f) => f.startsWith('session-')).map((f) => path.join(dir, f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
const L = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Learn which frames are routine: tx frames seen many times before the first marker.
const firstMark = L.findIndex((f) => f.mark);
const routine = new Map();
for (const f of L.slice(0, firstMark === -1 ? L.length : firstMark)) if (f.dir === 'tx' && f.hex) routine.set(f.hex, (routine.get(f.hex) || 0) + 1);
const isRoutineTx = (hex) => (routine.get(hex) || 0) > 3;

let on = !marker;
let skipNextRx = 0;
for (const f of L) {
  if (f.mark) { if (f.mark === marker) on = true; else if (on && marker) { console.log(`--- mark: ${f.mark}`); } if (on) console.log(`=== ${f.mark} @${f.t}`); continue; }
  if (!on) continue;
  if (f.side) { console.log(String(f.t).padStart(7), `side-${f.side}`, JSON.stringify(f.pairs)); continue; }
  const b = Buffer.from(f.hex, 'hex');
  if (!showAll) {
    if (b[2] === 0x71) continue;
    if (f.dir === 'tx' && isRoutineTx(f.hex)) continue;
    if (f.dir === 'rx' && b[2] === 0x06 && b.length === 65) continue; // meter poll reply
    if (f.dir === 'rx' && b[2] === 0x06 && b.length === 57) continue; // status poll reply
    if (f.dir === 'rx' && b[2] === 0x06 && b.length === 9) continue;
  }
  const ascii = [...b.slice(3, -2)].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
  console.log(String(f.t).padStart(7), f.dir, `fn=${b[2].toString(16).padStart(2, '0')}`, f.hex.slice(0, 160).replace(/(..)/g, '$1 ').trim(), b.length > 80 ? `(+${b.length - 80})` : '', ` |${ascii.slice(0, 40)}|`);
}
