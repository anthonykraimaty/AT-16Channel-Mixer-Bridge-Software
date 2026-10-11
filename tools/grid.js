// Print the parameter dump as a grid to reveal repeating per-strip blocks.
//   node tools/grid.js <base> <blockSize> <rows> [params.json]
const fs = require('fs');
const path = require('path');
const base = Number(process.argv[2] || 59);
const size = Number(process.argv[3] || 58);
const rows = Number(process.argv[4] || 24);
const P = JSON.parse(fs.readFileSync(process.argv[5] || path.join(__dirname, '..', 'captures', 'params.json'), 'utf8'));
const pad = (s, n) => String(s).padStart(n);
for (let off = 0; off < size; off++) {
  let line = pad(off, 3) + ' |';
  for (let r = 0; r < rows; r++) {
    const v = P[base + r * size + off];
    line += pad(v === undefined ? '-' : v, 6);
  }
  console.log(line);
}
