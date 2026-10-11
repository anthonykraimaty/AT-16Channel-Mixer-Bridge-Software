// Reads a watch-addrs log taken while an effect's settings were driven to
// their limits, and prints the lowest and highest value seen per effect.
//   node tools/fx-ranges.js <logfile> [typeAddr]
const fs = require('fs');

const file = process.argv[2];
const typeAddr = Number(process.argv[3] || 2128);
const lines = fs.readFileSync(file, 'utf8').split('\n');
const current = {};
const seen = {};
const start = lines.find((l) => l.includes('start:'));
if (start) for (const m of start.matchAll(/(\d+)=(\d+)/g)) current[m[1]] = Number(m[2]);

for (const line of lines) {
  const changes = [...line.matchAll(/(\d+): (\d+) -> (\d+)/g)];
  if (!changes.length) continue;
  const typeChange = changes.find((c) => Number(c[1]) === typeAddr);
  if (typeChange) {
    // Choosing an effect also loads its stored settings: not part of a sweep.
    for (const c of changes) current[c[1]] = Number(c[3]);
    continue;
  }
  const effect = ((current[typeAddr] - 1) % 16) + 1;
  for (const c of changes) {
    const addr = Number(c[1]);
    current[c[1]] = Number(c[3]);
    if (addr !== typeAddr + 1 && addr !== typeAddr + 2) continue;
    const key = `effect ${String(effect).padStart(2)} p${addr - typeAddr}`;
    const s = seen[key] || (seen[key] = { min: Infinity, max: -Infinity, n: 0 });
    for (const v of [Number(c[2]), Number(c[3])]) { s.min = Math.min(s.min, v); s.max = Math.max(s.max, v); }
    s.n++;
  }
}
for (const [key, s] of Object.entries(seen).sort()) console.log(`${key}: ${s.min} .. ${s.max}   (${s.n} changes)`);
