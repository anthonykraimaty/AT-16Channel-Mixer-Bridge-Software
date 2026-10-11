// Logging proxy used to study the mixer protocol.
// Serves the mixer's original web UI on http://localhost:<port>/ and relays its
// WebSocket to the mixer untouched, recording every frame in both directions.
//   node tools/capture-proxy.js [mixerHost] [port]
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const P = require('../server/protocol');

const mixerHost = process.argv[2] || '192.168.0.144';
const port = Number(process.argv[3] || 3999);
const original = path.join(__dirname, '..', 'captures', 'original-index.html');
const logFile = path.join(__dirname, '..', 'captures', `session-${Date.now()}.jsonl`);
const log = fs.createWriteStream(logFile);
const t0 = Date.now();
let marker = 'start';

// Redirect whatever socket the WASM opens to this proxy.
const shim = `<script>(function(){var N=window.WebSocket;function W(u,p){var t=(location.protocol==='https:'?'wss://':'ws://')+location.host+'/legacy-ws';var s=p?new N(t,p):new N(t);return s}W.prototype=N.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSING=2;W.CLOSED=3;window.WebSocket=W})();</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/mark') {
    marker = url.searchParams.get('m') || 'mark';
    log.write(JSON.stringify({ t: Date.now() - t0, mark: marker }) + '\n');
    res.end('ok ' + marker);
    return;
  }
  if (url.pathname === '/write' || url.pathname === '/read') {
    // Side channel for experiments: /write?130=0&129=100  or  /read?a=130&a=129
    const isWrite = url.pathname === '/write';
    const frame = isWrite
      ? P.encodeWrite([...url.searchParams.entries()].map(([a, v]) => [Number(a), Number(v)]))
      : P.encodeRead(url.searchParams.getAll('a').map(Number));
    const side = new WebSocket(`ws://${mixerHost}:8088/`, { perMessageDeflate: false, origin: `http://${mixerHost}` });
    const timer = setTimeout(() => { side.terminate(); res.writeHead(504); res.end('timeout'); }, 3000);
    side.on('open', () => side.send(frame));
    side.on('message', (d) => {
      const m = P.decode(d);
      if (!m || m.fn !== (isWrite ? P.FN.WRITE : P.FN.READ)) return;
      clearTimeout(timer);
      log.write(JSON.stringify({ t: Date.now() - t0, side: isWrite ? 'write' : 'read', pairs: P.decodePairs(m.payload) }) + '\n');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(P.decodePairs(m.payload)));
      side.close();
    });
    side.on('error', () => {});
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    let html = fs.readFileSync(original, 'utf8');
    html = html.replace('<head>', '<head>' + shim);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocket.Server({ server, path: '/legacy-ws', perMessageDeflate: false });
wss.on('connection', (client) => {
  const upstream = new WebSocket(`ws://${mixerHost}:8088/`, { perMessageDeflate: false, origin: `http://${mixerHost}` });
  const queue = [];
  const rec = (dir, data) => log.write(JSON.stringify({ t: Date.now() - t0, dir, hex: Buffer.from(data).toString('hex') }) + '\n');
  console.log('client connected');
  upstream.on('open', () => { queue.splice(0).forEach((d) => upstream.send(d, { binary: true })); });
  upstream.on('message', (d) => { rec('rx', d); if (client.readyState === 1) client.send(d, { binary: true }); });
  client.on('message', (d) => { rec('tx', d); if (upstream.readyState === 1) upstream.send(d, { binary: true }); else queue.push(d); });
  upstream.on('close', () => { console.log('mixer closed'); client.close(); });
  client.on('close', () => { console.log('client closed'); upstream.close(); });
  upstream.on('error', (e) => console.log('mixer error', e.message));
  client.on('error', (e) => console.log('client error', e.message));
});

server.listen(port, () => console.log(`capture proxy on http://localhost:${port}/  ->  ${mixerHost}   log: ${logFile}`));
