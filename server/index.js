// Mixer bridge: sits between browsers and the SY-X16 and holds the one
// connection to the mixer that everything shares.
//   /                 the new interface
//   /ws               its live connection (JSON, meters as binary frames)
//   /classic/         the mixer's original interface, through the shared connection
//   /classic-direct/  the original interface with a mixer connection of its own
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { Mixer } = require('./mixer');
const { Store } = require('./store');
const { Memory } = require('./memory');
const { Classic } = require('./classic');
const { Configs, cleanName } = require('./configs');
const { scan } = require('./scan');
const { Rta } = require('./rta');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
// Inside the Android app the program files are replaced with every update,
// so everything that must last is kept in a folder of its own.
const DATA = process.env.MIXER_DATA || path.join(ROOT, 'data');
const CONFIG_FILE = process.env.MIXER_DATA ? path.join(DATA, 'config.json') : path.join(ROOT, 'config.json');

function loadConfig() {
  // resumeHours: fader levels are put back after a connection drop if the
  // mixer was last in reach less than this long ago.
  const config = { mixerHost: '192.168.0.144', mixerPort: 8088, port: 8600, resumeHours: 12 };
  try {
    Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`config.json ignored: ${err.message}`);
  }
  if (process.env.MIXER_HOST) config.mixerHost = process.env.MIXER_HOST;
  if (process.env.PORT) config.port = Number(process.env.PORT);
  return config;
}

const config = loadConfig();
const store = new Store(path.join(DATA, 'settings.json'));
const memory = new Memory(path.join(DATA, 'levels.json'));
const rta = new Rta();
const rtaDevice = () => ((store.data.options || {}).rtaDevice) || '';
rta.setDevice(rtaDevice());
const mixer = new Mixer({ host: config.mixerHost, port: config.mixerPort, memory, resumeHours: Number(config.resumeHours) || 0 });
const classic = new Classic({ mixer, host: config.mixerHost, port: config.mixerPort, cacheFile: path.join(DATA, 'classic.html') });

const configs = new Configs(path.join(DATA, 'configs'));

const holdWanted = () => (store.data.options || {}).holdLevels !== false;
mixer.holdEnabled = holdWanted();

// --- static files ----------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=UTF-8', '.js': 'text/javascript; charset=UTF-8', '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { rel = '/'; }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.join(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000' : 'no-cache',
    });
    res.end(body);
  });
}

const CLASSIC_PAGES = { '/classic/': '/classic-ws', '/classic-direct/': '/classic-direct-ws' };

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
  if (CLASSIC_PAGES[`${pathname}/`]) { res.writeHead(302, { Location: `${pathname}/` }); res.end(); return; }
  if (CLASSIC_PAGES[pathname]) {
    if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
    classic.serve(res, CLASSIC_PAGES[pathname]);
    return;
  }
  // For the window program and for anyone curious: how things stand.
  if (pathname === '/status.json') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...status(), addresses: lanAddresses(), screens: appSockets.clients.size + classic.clients.size }));
    return;
  }
  const download = /^\/configs\/([a-z0-9]{6,24})\.json$/.exec(pathname);
  if (download) {
    const config = configs.read(download[1]);
    if (!config) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const file = (config.name.replace(/[^\w .-]+/g, '_').trim() || 'mixer') + '.json';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(config, null, 1));
    return;
  }
  serveStatic(req, res, pathname);
});

// --- live connections ------------------------------------------------------
const appSockets = new WebSocket.Server({ noServer: true, perMessageDeflate: false });
const classicSockets = new WebSocket.Server({ noServer: true, perMessageDeflate: false });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws') appSockets.handleUpgrade(req, socket, head, (ws) => appSockets.emit('connection', ws));
  else if (pathname === '/classic-ws') classicSockets.handleUpgrade(req, socket, head, (ws) => classic.attach(ws));
  else if (pathname === '/classic-direct-ws') classicSockets.handleUpgrade(req, socket, head, (ws) => classic.relay(ws));
  else socket.destroy();
});

const send = (ws, msg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
function broadcast(msg, except) {
  const text = JSON.stringify(msg);
  for (const ws of appSockets.clients) if (ws !== except && ws.readyState === WebSocket.OPEN) ws.send(text);
}

// Addresses of this computer, the one on the mixer's own network first.
function lanAddresses() {
  const prefix = config.mixerHost.split('.').slice(0, 3).join('.') + '.';
  const found = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) if (net.family === 'IPv4' && !net.internal) found.push(net.address);
    }
  } catch { /* Android does not let an app list its network interfaces */ }
  // The Android app looks its address up itself and leaves it in this file.
  try {
    const told = fs.readFileSync(path.join(DATA, 'address.txt'), 'utf8').trim();
    if (/^\d+\.\d+\.\d+\.\d+$/.test(told) && !found.includes(told)) found.push(told);
  } catch { /* not running inside the app */ }
  return found.sort((a, b) => Number(b.startsWith(prefix)) - Number(a.startsWith(prefix)));
}

// Point the bridge at another mixer address and remember it.
function changeMixer(host) {
  const clean = String(host || '').trim();
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(clean)) throw new Error('That does not look like an address.');
  if (clean === config.mixerHost) return;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first time */ }
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...saved, mixerHost: clean }, null, 2));
  config.mixerHost = clean;
  mixer.stop();
  mixer.host = clean;
  // What was held belongs to the mixer we are leaving.
  mixer.held.clear();
  mixer.everSynced = false;
  classic.host = clean;
  classic.html = null;
  console.log(`[mixer] address changed to ${clean}`);
  mixer.start();
}

const status = () => ({
  t: 'status', connected: mixer.connected, synced: mixer.synced, host: mixer.host, info: mixer.info,
  bridge: { address: lanAddresses()[0] || null, port: config.port },
});
const snapshot = () => ({ t: 'state', params: Array.from(mixer.params), names: mixer.names, scenes: mixer.scenes });

// --- looking for the mixer ---------------------------------------------------
// One search at a time; whoever asks while one runs watches that one.
let search = null;

function findMixer({ watcher, realOnly } = {}) {
  if (search) {
    if (watcher) {
      search.watchers.add(watcher);
      for (const entry of search.found) send(watcher, { t: 'scan', state: 'found', ...entry });
    }
    return search.done;
  }
  const mine = { found: [], watchers: new Set(watcher ? [watcher] : []) };
  const tell = (msg) => { for (const ws of mine.watchers) send(ws, { t: 'scan', ...msg }); };
  mine.done = scan({
    prefer: config.mixerHost,
    port: config.mixerPort,
    addresses: lanAddresses(),
    realOnly,
    onNetwork: (n) => tell({ state: 'network', from: n.from, to: n.to }),
    onProgress: (done, total) => tell({ state: 'progress', done, total }),
    onFound: (entry) => {
      // The mixer this bridge is talking to needs no second opinion.
      if (!entry.sure && entry.address === config.mixerHost && mixer.connected) Object.assign(entry, { sure: true, model: mixer.info.model });
      mine.found.push(entry);
      tell({ state: 'found', ...entry });
    },
  }).then((found) => {
    search = null;
    tell({ state: 'done', found, current: config.mixerHost });
    return found;
  }, (err) => {
    search = null;
    tell({ state: 'failed', message: err.message });
    return [];
  });
  search = mine;
  return mine.done;
}

// When the mixer does not answer, it may have been given another address:
// look for it, and if exactly one mixer is around, go there.
const autoFind = () => (store.data.options || {}).autoFind !== false;
const FIND_AFTER = 12000;
const FIND_AGAIN = [60000, 120000, 300000];
let lostAt = Date.now();
let lookedAt = 0;
let looks = 0;

async function lookAround() {
  if (mixer.connected || search || !autoFind()) return;
  const now = Date.now();
  if (now - lostAt < FIND_AFTER) return;
  if (looks > 0 && now - lookedAt < FIND_AGAIN[Math.min(looks, FIND_AGAIN.length) - 1]) return;
  looks++;
  lookedAt = now;
  console.log(`[mixer] no answer from ${config.mixerHost}, looking for the mixer...`);
  const found = (await findMixer({ realOnly: true })).filter((entry) => entry.sure);
  lookedAt = Date.now();
  if (mixer.connected || !autoFind()) return;
  if (found.some((entry) => entry.address === config.mixerHost)) return;
  if (found.length === 1) {
    console.log(`[mixer] found ${found[0].model || 'a mixer'} at ${found[0].address}`);
    try {
      changeMixer(found[0].address);
      broadcast(status());
      broadcast({ t: 'notice', kind: 'mixerFound', address: found[0].address, model: found[0].model });
    } catch (err) {
      console.log(`[mixer] could not switch: ${err.message}`);
    }
  } else if (found.length > 1) {
    console.log(`[mixer] found ${found.length} mixers (${found.map((entry) => entry.address).join(', ')}): choose one under Mixer address`);
  } else {
    console.log('[mixer] none found');
  }
}
setInterval(() => { lookAround().catch(() => {}); }, 4000);

// --- saved configurations --------------------------------------------------
const configList = () => ({ t: 'configs', list: configs.list() });

function saveCurrent(name) {
  if (!mixer.synced) throw new Error('The mixer is not connected.');
  return configs.save({
    model: mixer.info.model,
    name: cleanName(name) || 'Untitled',
    savedAt: Date.now(),
    params: Array.from(mixer.params),
    names: [...mixer.names],
    look: { strips: store.data.strips, views: store.data.views, mixes: store.data.mixes },
  });
}

// parts: { mixer, names, look } choose what is brought back.
async function applySaved(id, parts) {
  const config = configs.read(id);
  if (!config) throw new Error('That configuration could not be read.');
  if (!mixer.synced) throw new Error('The mixer is not connected.');
  const done = { name: config.name, settings: 0, names: 0, look: false };
  if (parts.mixer) done.settings = mixer.applySnapshot(config.params);
  if (parts.look) {
    store.replaceLook(config.look);
    broadcast({ t: 'meta', meta: store.data });
    done.look = true;
  }
  if (parts.names) {
    for (let slot = 0; slot < config.names.length; slot++) {
      if (config.names[slot] === mixer.names[slot]) continue;
      const text = await mixer.setName(slot, config.names[slot]);
      broadcast({ t: 'name', slot, text });
      done.names++;
    }
  }
  return done;
}

function watchMeters() {
  mixer.wantMeters = appSockets.clients.size > 0 || classic.clients.size > 0;
}
classic.onCount = watchMeters;

appSockets.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  watchMeters();
  send(ws, status());
  send(ws, { t: 'meta', meta: store.data });
  send(ws, configList());
  send(ws, rta.info());
  if (mixer.synced) send(ws, snapshot());

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'set' && Array.isArray(msg.d)) {
      if (!mixer.synced) return;
      mixer.set(msg.d.filter((p) => Array.isArray(p) && p.length === 2).slice(0, 256), ws);
    } else if (msg.t === 'name') {
      try {
        const slots = (Array.isArray(msg.slots) ? msg.slots : []).slice(0, 4);
        for (const slot of slots) {
          const text = await mixer.setName(slot, msg.text ?? '');
          broadcast({ t: 'name', slot, text });
        }
      } catch (err) {
        send(ws, { t: 'error', message: `Could not rename: ${err.message}` });
      }
    } else if (typeof msg.t === 'string' && msg.t.startsWith('config')) {
      try {
        if (msg.t === 'configSave') {
          const saved = saveCurrent(msg.name);
          send(ws, { t: 'notice', kind: 'configSaved', name: saved.name, replaced: saved.replaced });
        } else if (msg.t === 'configLoad') {
          const parts = msg.parts && typeof msg.parts === 'object' ? msg.parts : {};
          const done = await applySaved(String(msg.id), { mixer: parts.mixer !== false, names: parts.names !== false, look: parts.look !== false });
          broadcast({ t: 'notice', kind: 'configLoaded', ...done });
        } else if (msg.t === 'configDelete') {
          configs.remove(String(msg.id));
        } else if (msg.t === 'configImport') {
          const saved = configs.importFile(msg.config);
          send(ws, { t: 'notice', kind: 'configImported', name: saved.name, replaced: saved.replaced });
        }
        broadcast(configList());
      } catch (err) {
        send(ws, { t: 'error', message: err.message });
      }
    } else if (msg.t === 'scan') {
      findMixer({ watcher: ws });
    } else if (msg.t === 'mixerAddress') {
      try {
        changeMixer(msg.host);
        broadcast(status());
      } catch (err) {
        send(ws, { t: 'error', message: err.message });
      }
    } else if (msg.t === 'rta') {
      rta.watch(ws, msg.on === true);
    } else if (msg.t === 'rtaDevices') {
      send(ws, { t: 'rtaDevices', list: await rta.list() });
    } else if (msg.t === 'meta') {
      if (store.patch(msg.path, msg.value)) {
        broadcast({ t: 'metaPatch', path: msg.path, value: msg.value ?? null }, ws);
        if (msg.path[0] === 'options') { mixer.setHold(holdWanted()); rta.setDevice(rtaDevice()); }
      } else {
        send(ws, { t: 'error', message: 'That setting could not be saved.' });
      }
    }
  });
  ws.on('close', () => { watchMeters(); rta.watch(ws, false); });
  ws.on('error', () => {});
});

// Drop browsers that vanished without closing (phone locked, Wi-Fi lost).
setInterval(() => {
  for (const ws of appSockets.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 15000);

// A steady beat, so a browser can tell a silent link from a dead one.
setInterval(() => broadcast({ t: 'tick' }), 2000);

mixer.on('status', () => broadcast(status()));
mixer.on('status', () => {
  if (mixer.connected) { lostAt = 0; looks = 0; } else if (!lostAt) lostAt = Date.now();
});
mixer.on('synced', () => broadcast(snapshot()));
mixer.on('params', (pairs, origin) => broadcast({ t: 'p', d: pairs }, origin));
mixer.on('name', (slot, text) => broadcast({ t: 'name', slot, text }));
mixer.on('restored', (count) => broadcast({ t: 'notice', kind: 'restored', count }));
mixer.on('meters', (meters) => {
  for (const ws of appSockets.clients) {
    // Meters are disposable: skip a client that is falling behind.
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 4096) ws.send(meters, { binary: true });
  }
});
// The spectrum goes only to the screens showing it.
rta.on('state', (info) => broadcast(info));
rta.on('frame', (bands) => {
  const text = JSON.stringify({ t: 'rta', b: bands });
  for (const ws of rta.watchers) if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 8192) ws.send(text);
});
mixer.on('log', (line) => console.log(`[mixer] ${line}`));

let lastLine = '';
mixer.on('status', () => {
  const line = mixer.connected ? (mixer.synced ? `in sync with ${mixer.info.model || 'mixer'}` : 'connected, reading settings...') : 'connection lost, reconnecting...';
  if (line !== lastLine) console.log(`[mixer] ${line}`);
  lastLine = line;
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${config.port} is already in use. Set another "port" in config.json.`);
  else console.error(err.message);
  process.exit(1);
});

function shutdown() {
  rta.close();
  mixer.remember(true);
  memory.flush();
  process.exit(0);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);

// Started by the window program (MixerBridge.exe): it asks for a tidy stop
// with a line of text, and if it disappears the bridge goes with it.
if (process.env.MIXER_GUI) {
  process.stdin.on('data', (text) => { if (String(text).includes('stop')) shutdown(); });
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
  process.stdin.resume();
}

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Mixer bridge for ${config.mixerHost}`);
  console.log(`  this computer   http://localhost:${config.port}/`);
  const [lan, ...others] = lanAddresses();
  if (lan) console.log(`  phones/tablets  http://${lan}:${config.port}/`);
  if (others.length) console.log(`  other networks  ${others.map((a) => `http://${a}:${config.port}/`).join('  ')}`);
  console.log(`  original UI     http://localhost:${config.port}/classic/`);
  mixer.start();
});
