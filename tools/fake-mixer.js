// A stand-in for the mixer, to study how the original interface draws things.
// Serves the original page and answers its requests from a saved snapshot;
// the meter values are whatever was last set over HTTP. The real mixer is
// never contacted.
//   node tools/fake-mixer.js [port] [snapshot.json]
//   GET /meters?all=200          every meter byte to 200
//   GET /meters?set=24:200,25:210  single meter indexes
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const P = require('../server/protocol');

const port = Number(process.argv[2] || 3998);
const root = path.join(__dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(process.argv[3] || path.join(root, 'captures', 'snapshot-5.json'), 'utf8'));
const page = fs.readFileSync(path.join(root, 'data', 'classic.html'), 'utf8');
const meters = new Uint8Array(94).fill(181);

const shim = `<script>(function(){var N=window.WebSocket;function W(u,p){var t='ws://'+location.host+'/ws';return p?new N(t,p):new N(t)}W.prototype=N.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSING=2;W.CLOSED=3;window.WebSocket=W})();</script>`;
const INFO = Buffer.from('00e0022201' + Buffer.from('SY-X16').toString('hex') + '00', 'hex');
const STATUS = ['800f710006011f0000000000000208bab1', '800f718000000000000000000000001f70'].map((h) => Buffer.from(h, 'hex'));

const valueOf = (a) => {
  if (a >= 2 && a <= 48) return (meters[(a - 2) * 2] << 8) | meters[(a - 2) * 2 + 1];
  return snapshot[a] || 0;
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/meters') {
    if (url.searchParams.has('all')) meters.fill(Number(url.searchParams.get('all')) & 255);
    for (const pair of (url.searchParams.get('set') || '').split(',').filter(Boolean)) {
      const [i, v] = pair.split(':').map(Number);
      if (i >= 0 && i < meters.length) meters[i] = v & 255;
    }
    res.end('ok');
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(page.replace('<head>', '<head>' + shim));
    return;
  }
  res.writeHead(404); res.end();
});

// Any path: the original page asks for /ws, the bridge for /.
const wss = new WebSocket.Server({ server, perMessageDeflate: false });
wss.on('connection', (ws) => {
  let n = 0;
  const beat = setInterval(() => { if (ws.readyState === 1) ws.send(STATUS[n++ % 2]); }, 450);
  ws.on('close', () => clearInterval(beat));
  ws.on('message', (data) => {
    const m = P.decode(data);
    if (!m) return;
    const p = m.payload;
    if (m.fn === P.FN.READ) {
      const out = Buffer.alloc(p.length * 2);
      for (let i = 0; i + 1 < p.length; i += 2) {
        const a = p.readUInt16BE(i);
        out.writeUInt16BE(a, i * 2);
        out.writeUInt16BE(valueOf(a), i * 2 + 2);
      }
      ws.send(P.encode(P.FN.READ, out));
    } else if (m.fn === P.FN.WRITE) {
      for (const [a, v] of P.decodePairs(p)) snapshot[a] = v;
      ws.send(data);
    } else if (m.fn === P.FN.INFO) ws.send(P.encode(P.FN.INFO, INFO));
    else if (m.fn === P.FN.SCENE_NAME) ws.send(P.encodeIndexed(P.FN.SCENE_NAME, p[0], 'Factory'));
    else if (m.fn === P.FN.NAME) ws.send(P.encodeIndexed(P.FN.NAME, p[0], ''));
    else if (m.fn === P.FN.SET_NAME) ws.send(data);
    else if (m.fn === P.FN.CONFIG) ws.send(P.encode(P.FN.CONFIG, Buffer.from(p.toString('latin1') + (p.toString('latin1') === 'DEVNAME=' ? 'SY-X16' : '') + '\n', 'latin1')));
  });
});

server.listen(port, () => console.log(`stand-in mixer on http://localhost:${port}/`));
