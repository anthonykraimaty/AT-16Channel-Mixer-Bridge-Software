// Reads the screenshots of one meter bar of the original interface, taken at
// known meter values, and prints where the bar ends and what colours it has.
//   node tools/meter-law.js <folder>
// Files are named s<nnn>-<value>.png (or fall-<ms>.png).
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const dir = process.argv[2];
// The clip starts at y=250 of the page; the scale of the original interface
// has these marks (page y): +10 at 256, 0 at 366, -inf at 805.
const Y0 = 250, TOP = 256, BOTTOM = 805;

function measure(file) {
  const img = PNG.sync.read(fs.readFileSync(file));
  // The bar is the brightest column: find lit rows along the middle columns.
  let top = null, bottom = null;
  const colours = new Map();
  for (let y = 0; y < img.height; y++) {
    let lit = null;
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
      if (Math.max(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) > 90) { lit = [r, g, b]; break; }
    }
    if (!lit) continue;
    if (top === null) top = y;
    bottom = y;
    const key = lit.map((c) => Math.round(c / 32) * 32).join(',');
    if (!colours.has(key)) colours.set(key, [y, y]); else colours.get(key)[1] = y;
  }
  return { top: top === null ? null : top + Y0, bottom: bottom === null ? null : bottom + Y0, colours: [...colours].map(([k, [a, b]]) => `${k}@${a + Y0}-${b + Y0}`) };
}

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
for (const f of files) {
  const m = measure(path.join(dir, f));
  const value = f.replace('.png', '').replace(/^s\d+-/, '');
  const fraction = m.top === null ? 0 : (BOTTOM - m.top) / (BOTTOM - TOP);
  console.log(value.padStart(9), 'top', String(m.top).padStart(4), 'height', fraction.toFixed(3), m.colours.join('  '));
}
