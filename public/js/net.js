// Live link to the bridge and the local mirror of the mixer's state.
const M = window.MixerModel;

const SEND_INTERVAL = 30;
const HOLD_GRACE = 400;

export const state = {
  params: new Uint16Array(M.PARAM_COUNT),
  names: new Array(M.NAME_SLOTS).fill(''),
  scenes: [],
  meters: new Uint8Array(M.METER_ADDR_COUNT * 2).fill(M.METER_FLOOR),
  meta: { strips: {}, views: [], mixes: {}, options: {} },
  configs: [],
  link: 'connecting', // connecting | offline | mixer-offline | syncing | ready
  host: '',
  model: '',
  bridge: null,
  loaded: false,
  rta: { state: 'unsupported' },
};

const listeners = new Map();
export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
}
export function off(event, fn) {
  const set = listeners.get(event);
  if (set) set.delete(fn);
}
function emit(event, ...args) {
  const set = listeners.get(event);
  if (set) for (const fn of set) fn(...args);
}

// Addresses being dragged right now: updates from elsewhere are ignored for
// them so a fader never fights the finger holding it.
const held = new Map();
export function hold(addrs) {
  for (const a of addrs) held.set(a, Infinity);
}
export function release(addrs) {
  const until = performance.now() + HOLD_GRACE;
  for (const a of addrs) held.set(a, until);
}
function isHeld(a) {
  const until = held.get(a);
  if (until === undefined) return false;
  if (until > performance.now()) return true;
  held.delete(a);
  return false;
}

let ws = null;
let retry = 0;
const outbox = new Map();
let flushTimer = null;

function setLink(link) {
  if (state.link === link) return;
  state.link = link;
  emit('link', link);
}

// The bridge sends something at least every two seconds. Silence for longer
// than this means the link is dead even if the browser has not noticed.
const SILENCE_LIMIT = 7000;
let lastHeard = 0;
let retryTimer = null;

function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  if (ws) return;
  const scheme = location.protocol === 'https:' ? 'wss://' : 'ws://';
  const socket = new WebSocket(`${scheme}${location.host}/ws`);
  ws = socket;
  socket.binaryType = 'arraybuffer';
  lastHeard = performance.now();
  socket.onopen = () => { retry = 0; lastHeard = performance.now(); };
  socket.onmessage = (event) => {
    lastHeard = performance.now();
    if (typeof event.data !== 'string') {
      state.meters = new Uint8Array(event.data);
      emit('meters', state.meters);
      return;
    }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    handle(msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setLink('offline');
    retry = Math.min(retry + 1, 5);
    retryTimer = setTimeout(connect, 300 * retry);
  };
  socket.onerror = () => {};
}

// Give up on a socket without waiting for the browser to time it out.
function drop() {
  const socket = ws;
  if (!socket) return;
  ws = null;
  socket.onclose = socket.onmessage = socket.onopen = null;
  try { socket.close(); } catch { /* already closed */ }
  setLink('offline');
}

// Check the link and repair it at once if it is gone.
function revive() {
  if (ws && ws.readyState <= WebSocket.OPEN && performance.now() - lastHeard < SILENCE_LIMIT) return;
  drop();
  retry = 0;
  connect();
}

setInterval(() => {
  if (ws && performance.now() - lastHeard > SILENCE_LIMIT) revive();
}, 2000);
// A phone waking up, a tab coming back, Wi-Fi returning: reconnect right away.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') revive(); });
window.addEventListener('pageshow', revive);
window.addEventListener('online', revive);
window.addEventListener('focus', revive);

function handle(msg) {
  switch (msg.t) {
    case 'status':
      state.host = msg.host;
      state.model = (msg.info && msg.info.model) || '';
      state.bridge = msg.bridge || null;
      if (!msg.connected) setLink('mixer-offline');
      else if (!msg.synced) setLink('syncing');
      else if (state.loaded) setLink('ready');
      emit('status');
      break;
    case 'state':
      state.params.set(msg.params);
      state.names = msg.names;
      state.scenes = msg.scenes || [];
      state.loaded = true;
      setLink('ready');
      emit('reset');
      break;
    case 'p': {
      const changed = [];
      for (const [a, v] of msg.d) {
        if (isHeld(a) || state.params[a] === v) continue;
        state.params[a] = v;
        changed.push(a);
      }
      if (changed.length) emit('params', changed);
      break;
    }
    case 'name':
      state.names[msg.slot] = msg.text;
      emit('names');
      break;
    case 'meta':
      state.meta = { strips: {}, views: [], mixes: {}, options: {}, ...msg.meta };
      emit('meta');
      break;
    case 'notice':
      emit('notice', msg);
      break;
    case 'scan':
      emit('scan', msg);
      break;
    case 'configs':
      state.configs = Array.isArray(msg.list) ? msg.list : [];
      emit('configs');
      break;
    case 'metaPatch':
      applyPatch(msg.path, msg.value);
      emit('meta');
      break;
    case 'error':
      emit('error', msg.message);
      break;
    case 'rtaState':
      state.rta = msg;
      // A new link, or a bridge that restarted: ask again for the spectrum.
      if (rtaWanted > 0) quietSend({ t: 'rta', on: true });
      emit('rtaState', msg);
      break;
    case 'rta':
      emit('rta', msg.b);
      break;
    case 'rtaDevices':
      emit('rtaDevices', Array.isArray(msg.list) ? msg.list : []);
      break;
    default:
  }
}

function applyPatch(path, value) {
  const [root, entry] = path;
  if (entry !== undefined && !state.meta[root]) state.meta[root] = {};
  if (entry === undefined) state.meta[root] = value;
  else if (value === null) delete state.meta[root][entry];
  else state.meta[root][entry] = value;
}

function flush() {
  flushTimer = null;
  if (!outbox.size || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ t: 'set', d: [...outbox.entries()] }));
  outbox.clear();
}

// Change parameters. The local mirror updates at once; the mixer follows.
export function set(pairs) {
  if (state.link !== 'ready') return;
  const changed = [];
  for (const [a, raw] of pairs) {
    const v = M.sanitize(a, raw, get);
    if (v === null || state.params[a] === v) continue;
    state.params[a] = v;
    outbox.set(a, v);
    changed.push(a);
  }
  if (!changed.length) return;
  emit('params', changed);
  if (!flushTimer) flushTimer = setTimeout(flush, SEND_INTERVAL);
}

export function rename(slots, text) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'name', slots, text }));
}

// quiet: the caller updates the screen itself, no redraw is needed here.
export function patchMeta(path, value, { quiet = false } = {}) {
  applyPatch(path, value);
  if (!quiet) emit('meta');
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'meta', path, value }));
}

// Any other request to the bridge. Returns false when there is no link.
function quietSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// The spectrum of the sound card input is sent only while someone looks at it.
let rtaWanted = 0;
export function watchRta(on) {
  rtaWanted = Math.max(0, rtaWanted + (on ? 1 : -1));
  quietSend({ t: 'rta', on: rtaWanted > 0 });
}
export function listRtaDevices() {
  quietSend({ t: 'rtaDevices' });
}

export function send(msg) {
  if (!ws || ws.readyState !== WebSocket.OPEN) { emit('error', 'Not connected to the bridge.'); return false; }
  ws.send(JSON.stringify(msg));
  return true;
}

export const get = (addr) => state.params[addr];

export function start() {
  connect();
}
