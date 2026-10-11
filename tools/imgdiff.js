// Compare consecutive screenshots and produce one contact sheet showing only
// the regions that changed (before on the left, after on the right).
//   node tools/imgdiff.js out.png a.png b.png c.png ...
// Compares a->b, b->c, ...
const fs = require('fs');
const { PNG } = require('pngjs');

// With --base every image is compared with the first one instead of its predecessor.
const baseMode = process.argv.includes('--base');
const [out, ...files] = process.argv.slice(2).filter((a) => a !== '--base');
const imgs = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
const rows = [];
for (let i = 1; i < imgs.length; i++) {
  const a = imgs[baseMode ? 0 : i - 1], b = imgs[i];
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
  for (let y = 0; y < b.height; y++) for (let x = 0; x < b.width; x++) {
    const p = (y * b.width + x) * 4;
    const d = Math.abs(a.data[p] - b.data[p]) + Math.abs(a.data[p + 1] - b.data[p + 1]) + Math.abs(a.data[p + 2] - b.data[p + 2]);
    if (d > 40) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (n === 0) { console.log(`${files[i]}: no change`); rows.push(null); continue; }
  const pad = 14;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(b.width - 1, x1 + pad); y1 = Math.min(b.height - 1, y1 + pad);
  // Cap very large regions so the sheet stays readable.
  const w = Math.min(x1 - x0 + 1, 440), h = Math.min(y1 - y0 + 1, 260);
  console.log(`${files[i]}: ${n} px changed, box x=${x0}..${x1} y=${y0}..${y1}`);
  rows.push({ a, b, x0, y0, w, h, label: files[i] });
}
const live = rows.filter(Boolean);
if (!live.length) process.exit(0);
const W = Math.max(...live.map((r) => r.w * 2 + 12)) + 8;
const H = live.reduce((s, r) => s + r.h + 10, 0) + 8;
const sheet = new PNG({ width: W, height: H });
sheet.data.fill(255);
let y = 4;
for (const r of live) {
  for (const [img, ox] of [[r.a, 4], [r.b, 4 + r.w + 12]]) {
    for (let yy = 0; yy < r.h; yy++) for (let xx = 0; xx < r.w; xx++) {
      const s = ((r.y0 + yy) * img.width + r.x0 + xx) * 4;
      const d = ((y + yy) * W + ox + xx) * 4;
      sheet.data[d] = img.data[s]; sheet.data[d + 1] = img.data[s + 1]; sheet.data[d + 2] = img.data[s + 2]; sheet.data[d + 3] = 255;
    }
  }
  y += r.h + 10;
}
fs.writeFileSync(out, PNG.sync.write(sheet));
console.log('sheet', out, W, 'x', H);
