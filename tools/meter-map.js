// Works out which meter index each bar of the original interface shows.
// Two screenshots of the same page: in the first every meter index i lights
// (i % 12) + 1 segments, in the second floor(i / 12) + 1.
//   node tools/meter-map.js a.png b.png
const fs = require('fs');
const { PNG } = require('pngjs');

const TOP = 256, BOTTOM = 805, SEG = (BOTTOM - TOP) / 12;
const lit = (img, x, y) => {
  const i = (y * img.width + x) * 4;
  const [r, g, b] = [img.data[i], img.data[i + 1], img.data[i + 2]];
  return Math.max(r, g, b) > 150 && Math.max(r, g, b) - Math.min(r, g, b) > 90;
};

function bars(img) {
  // Every bar has its lowest segment lit: look along a row near the bottom.
  const y = BOTTOM - 8;
  const out = [];
  let start = null;
  for (let x = 0; x <= img.width; x++) {
    const on = x < img.width && lit(img, x, y);
    if (on && start === null) start = x;
    if (!on && start !== null) { if (x - start >= 3) out.push([start, x - 1]); start = null; }
  }
  return out;
}

function segments(img, [x0, x1]) {
  const x = Math.round((x0 + x1) / 2);
  let top = BOTTOM;
  for (let y = TOP - 2; y < BOTTOM; y++) if (lit(img, x, y)) { top = y; break; }
  return Math.round((BOTTOM - top) / SEG);
}

const [a, b] = process.argv.slice(2).map((f) => PNG.sync.read(fs.readFileSync(f)));
for (const bar of bars(a)) {
  const low = segments(a, bar), high = segments(b, bar);
  console.log(`bar at x=${bar[0]}..${bar[1]}: meter index ${(low - 1) + 12 * (high - 1)}  (segments ${low}, ${high})`);
}
