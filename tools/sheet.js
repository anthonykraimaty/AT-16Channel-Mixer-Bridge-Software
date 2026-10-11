// Put several same-sized screenshots on one sheet, in a grid.
//   node tools/sheet.js out.png columns a.png b.png ...
const fs = require('fs');
const { PNG } = require('pngjs');

const [out, columns, ...files] = process.argv.slice(2);
const cols = Number(columns);
const imgs = files.map((f) => PNG.sync.read(fs.readFileSync(f)));
const w = Math.max(...imgs.map((i) => i.width)), h = Math.max(...imgs.map((i) => i.height));
const gap = 6;
const rows = Math.ceil(imgs.length / cols);
const sheet = new PNG({ width: cols * (w + gap) + gap, height: rows * (h + gap) + gap });
sheet.data.fill(255);
imgs.forEach((img, n) => {
  const ox = gap + (n % cols) * (w + gap), oy = gap + Math.floor(n / cols) * (h + gap);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const s = (y * img.width + x) * 4, d = ((oy + y) * sheet.width + ox + x) * 4;
    img.data.copy(sheet.data, d, s, s + 4);
  }
});
fs.writeFileSync(out, PNG.sync.write(sheet));
console.log(out, sheet.width, 'x', sheet.height);
