// The one connection to the mixer. Keeps a mirror of every parameter, name
// and meter, applies writes, reports changes made elsewhere, reconnects on
// its own and puts the fader levels back after a connection drop.
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const P = require('./protocol');
const M = require('../public/js/model');

const REQUEST_TIMEOUT = 1500;
const LIVE_INTERVAL = 66;
const IDLE_INTERVAL = 1000;
const STATUS_INTERVAL = 500;
const WRITE_INTERVAL = 25;
const RECONNECT_DELAYS = [300, 600, 1000, 2000, 3000];
// A value we just wrote wins over a background re-read for this long.
const WRITE_GUARD = 1500;
// When its last client leaves, the mixer fades every fader to where it
// physically stands, a step every tenth of a second for over two seconds,
// and announces each step. Reconnecting inside that fade, the bridge writes
// the held level back after every step; once no step has been seen for
// QUIET_TIME it checks the levels a final time.
const QUIET_TIME = 600;
// An address the original interface asked about is polled this long.
const HOT_TIME = 10000;

// Live readings (meters and status), polled rather than announced.
const LIVE_FAST = range(0, 60);
const LIVE_SLOW = [...range(60, 4), ...range(2269, 15)];
// Functions the bridge answers itself; everything else is passed through.
const OWN_FUNCTIONS = new Set([P.FN.INFO, P.FN.WRITE, P.FN.SCENE_NAME, P.FN.READ, P.FN.PUSH, P.FN.NAME, P.FN.SET_NAME]);

const isSetting = (a) => a >= M.BLOCK.in.base && (a < 2269 || a > 2283);
const HELD = new Set(M.HELD);

class Mixer extends EventEmitter {
  // memory: { load(), save(data) } keeps the held levels across restarts.
  constructor({ host, port = 8088, memory, resumeHours = 12 }) {
    super();
    this.host = host;
    this.port = port;
    this.memory = memory;
    this.resumeHours = resumeHours;
    this.holdEnabled = true;

    this.params = new Uint16Array(M.PARAM_COUNT);
    this.names = new Array(M.NAME_SLOTS).fill('');
    this.scenes = [];
    this.meters = Buffer.alloc(M.METER_ADDR_COUNT * 2, M.METER_FLOOR);
    this.info = { model: '' };
    this.infoFrame = null;
    this.connected = false;
    this.synced = false;
    this.everSynced = false;
    this.wantMeters = false;

    this.held = new Map();
    this.seenAt = 0;
    const saved = memory && memory.load();
    if (saved && saved.values) {
      for (const [a, v] of Object.entries(saved.values)) if (HELD.has(Number(a))) this.held.set(Number(a), v);
      this.seenAt = saved.seenAt || 0;
    }

    this.ws = null;
    this.queue = [];
    this.current = null;
    this.pendingWrites = new Map();
    this.lastWrite = new Map();
    this.hot = new Map();
    this.timers = [];
    this.busy = {};
    this.resuming = false;
    this.failures = 0;
    this.attempt = 0;
    this.stopped = false;
    this.connectedAt = 0;
    this.lastPull = 0;
    this.putBack = new Set();
    this.sweepAddr = M.BLOCK.in.base;
    this.sweepName = 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.teardown();
  }

  // --- connection --------------------------------------------------------
  connect() {
    if (this.stopped || this.ws) return;
    const ws = new WebSocket(`ws://${this.host}:${this.port}/`, { perMessageDeflate: false, origin: `http://${this.host}`, handshakeTimeout: 3000 });
    this.ws = ws;
    ws.on('open', () => this.onOpen(ws));
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.onClose(ws));
    ws.on('error', (err) => { if (this.attempt < 2) this.emit('log', `mixer socket: ${err.message}`); });
  }

  teardown() {
    this.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    clearTimeout(this.resyncTimer);
    this.timers = [];
    if (this.current) clearTimeout(this.current.timer);
    const failed = [this.current, ...this.queue].filter(Boolean);
    this.current = null;
    this.queue = [];
    this.busy = {};
    failed.forEach((r) => r.reject(new Error('disconnected')));
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.on('error', () => {});
      try { this.ws.terminate(); } catch { /* already closed */ }
      this.ws = null;
    }
    this.resuming = false;
    if (this.connected) {
      this.remember(true);
      this.connected = false;
      this.synced = false;
      this.emit('status');
    }
  }

  onClose(ws) {
    if (ws !== this.ws) return;
    this.teardown();
    if (this.stopped) return;
    const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)];
    this.attempt++;
    setTimeout(() => this.connect(), delay);
  }

  async onOpen(ws) {
    this.connected = true;
    this.failures = 0;
    this.busy = {};
    const resumable = this.holdEnabled && this.held.size > 0 && Date.now() - this.seenAt <= this.resumeHours * 3600e3;
    this.resuming = resumable;
    this.connectedAt = Date.now();
    this.lastPull = 0;
    this.putBack = new Set();
    this.emit('status');
    // The mixer drops clients that stay silent for about five seconds.
    this.every(LIVE_INTERVAL, () => this.pollLive());
    this.every(STATUS_INTERVAL, () => this.pollStatus());
    this.every(WRITE_INTERVAL, () => this.flushWrites());
    try {
      // Levels first: every moment at the wrong level is audible.
      if (resumable) await this.restoreHeld();
      await this.readAll(true);
    } catch (err) {
      this.emit('log', `initial sync failed: ${err.message}`);
      if (ws === this.ws) ws.terminate();
      return;
    }
    if (ws !== this.ws) return;
    if (!resumable) this.held.clear();
    for (const a of HELD) if (!this.held.has(a)) this.held.set(a, this.params[a]);
    this.attempt = 0;
    this.synced = true;
    this.everSynced = true;
    this.remember(true);
    this.emit('status');
    this.emit('synced');
    this.every(IDLE_INTERVAL, () => this.sweep());
    this.every(30000, () => this.remember(true));
    if (resumable) this.every(200, () => this.finishResume());
  }

  // Ends the resume phase once the mixer has stopped pulling at the faders
  // and every held level is confirmed to be in place.
  async finishResume() {
    if (!this.resuming || this.busy.resume) return;
    const now = Date.now();
    if (now - this.lastPull < QUIET_TIME || now - this.connectedAt < QUIET_TIME) return;
    this.busy.resume = true;
    try {
      const wrong = await this.restoreHeld();
      if (wrong) {
        this.lastPull = Date.now();
      } else {
        this.resuming = false;
        if (this.putBack.size) this.emit('restored', this.putBack.size);
        this.putBack = new Set();
      }
    } catch { /* the link dropped again; the next connect resumes */ } finally {
      this.busy.resume = false;
    }
  }

  every(ms, fn) {
    this.timers.push(setInterval(fn, ms));
  }

  // --- request plumbing --------------------------------------------------
  request(frame, fn, urgent = false) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected'));
      const req = { frame, fn, resolve, reject, timer: null };
      if (urgent) this.queue.unshift(req); else this.queue.push(req);
      this.pump();
    });
  }

  pump() {
    if (this.current || !this.queue.length || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const req = this.queue.shift();
    this.current = req;
    req.timer = setTimeout(() => {
      if (this.current !== req) return;
      this.current = null;
      req.reject(new Error(`no reply to function 0x${req.fn.toString(16)}`));
      if (++this.failures >= 3 && this.ws) this.ws.terminate();
      else this.pump();
    }, REQUEST_TIMEOUT);
    this.ws.send(req.frame);
  }

  onMessage(ws, data) {
    if (ws !== this.ws) return;
    const msg = P.decode(data);
    if (!msg) return;
    if (msg.fn === P.FN.PUSH) {
      // A change made elsewhere. The mixer expects the frame echoed back.
      ws.send(data);
      this.applyExternal(P.decodePairs(msg.payload));
      return;
    }
    const req = this.current;
    if (req && req.fn === msg.fn) {
      clearTimeout(req.timer);
      this.current = null;
      this.failures = 0;
      req.resolve(msg);
      this.pump();
      return;
    }
    // Status reports and answers to passed-through requests.
    if (!OWN_FUNCTIONS.has(msg.fn)) this.emit('foreign', data);
  }

  // Pass a request of the original interface through untouched. Whatever the
  // mixer answers comes back as a 'foreign' frame.
  forward(frame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(frame);
    // It may have changed anything (a scene recall, for one): look again.
    clearTimeout(this.resyncTimer);
    this.resyncTimer = setTimeout(() => this.resync(), 400);
    return true;
  }

  // --- state -------------------------------------------------------------
  async readAll(initial) {
    const info = await this.request(P.encode(P.FN.INFO, Buffer.from([0])), P.FN.INFO);
    this.infoFrame = P.encode(P.FN.INFO, info.payload);
    this.info = { model: info.payload.subarray(5).toString('latin1').replace(/\0.*$/, '') };

    for (let a = M.BLOCK.in.base; a < M.PARAM_COUNT; a += P.MAX_READ) {
      const n = Math.min(P.MAX_READ, M.PARAM_COUNT - a);
      const reply = await this.request(P.encodeRead(range(a, n)), P.FN.READ);
      const pairs = P.decodePairs(reply.payload);
      if (initial) {
        for (const [addr, value] of pairs) this.params[addr] = this.resuming && this.held.has(addr) ? this.held.get(addr) : value;
      } else {
        this.applyFresh(pairs);
      }
    }
    for (let i = 0; i < M.NAME_SLOTS; i++) {
      const name = await this.readName(i);
      if (name !== this.names[i]) {
        this.names[i] = name;
        if (!initial) this.emit('name', i, name);
      }
    }
    const scenes = [];
    for (let i = 1; i <= 16; i++) {
      const reply = await this.request(P.encodeIndexed(P.FN.SCENE_NAME, i), P.FN.SCENE_NAME);
      scenes.push(P.decodeIndexed(reply.payload).text);
    }
    const changed = scenes.join('\n') !== this.scenes.join('\n');
    this.scenes = scenes;
    if (changed && !initial) this.emit('scenes');
  }

  async resync() {
    if (!this.synced || this.busy.resync) return;
    this.busy.resync = true;
    try { await this.readAll(false); } catch { /* the sweep catches up */ } finally { this.busy.resync = false; }
  }

  async readName(index) {
    const reply = await this.request(P.encodeIndexed(P.FN.NAME, index), P.FN.NAME);
    return P.decodeIndexed(reply.payload).text;
  }

  // Values read back from the mixer, minus the ones we are about to change.
  applyFresh(pairs) {
    const now = Date.now();
    this.applyExternal(pairs.filter(([a]) => isSetting(a) && !this.pendingWrites.has(a) && now - (this.lastWrite.get(a) || 0) > WRITE_GUARD));
  }

  applyExternal(pairs) {
    const changed = [];
    for (const [addr, value] of pairs) {
      if (addr >= M.PARAM_COUNT) continue;
      if (this.resuming && this.held.has(addr)) {
        // The mixer pulling a fader towards its physical position: pull back.
        if (value !== this.held.get(addr)) {
          this.pendingWrites.set(addr, this.held.get(addr));
          this.putBack.add(addr);
          this.lastPull = Date.now();
        }
        continue;
      }
      if (this.params[addr] === value) continue;
      this.params[addr] = value;
      if (HELD.has(addr)) this.held.set(addr, value);
      changed.push([addr, value]);
    }
    if (!changed.length) return;
    this.remember();
    if (this.synced) this.emit('params', changed, null);
  }

  // Compare the held fader levels with what the mixer has and write back
  // the ones that differ. Returns how many were put back.
  async restoreHeld() {
    const addrs = [...this.held.keys()];
    const wrong = [];
    for (let i = 0; i < addrs.length; i += P.MAX_READ) {
      const reply = await this.request(P.encodeRead(addrs.slice(i, i + P.MAX_READ)), P.FN.READ, true);
      for (const [a, v] of P.decodePairs(reply.payload)) if (this.held.get(a) !== v) wrong.push([a, this.held.get(a)]);
    }
    for (let i = 0; i < wrong.length; i += P.MAX_WRITE) {
      await this.request(P.encodeWrite(wrong.slice(i, i + P.MAX_WRITE)), P.FN.WRITE, true);
    }
    const now = Date.now();
    for (const [a, v] of wrong) {
      this.params[a] = v;
      this.lastWrite.set(a, now);
      this.putBack.add(a);
    }
    return wrong.length;
  }

  // Save the held levels. `seen` also records that the mixer was in reach.
  remember(seen = false) {
    if (!this.memory) return;
    if (seen && this.connected && this.everSynced) this.seenAt = Date.now();
    this.memory.save({ seenAt: this.seenAt, values: Object.fromEntries(this.held) });
  }

  setHold(enabled) {
    this.holdEnabled = Boolean(enabled);
    if (this.synced) for (const a of HELD) this.held.set(a, this.params[a]);
    this.remember();
  }

  // --- polling -----------------------------------------------------------
  // Background re-read of settings and names, a slice at a time. Catches
  // anything a missed notification would otherwise leave stale.
  async sweep() {
    if (!this.synced || this.busy.sweep || this.busy.resync || this.queue.length > 4) return;
    this.busy.sweep = true;
    const a = this.sweepAddr;
    const n = Math.min(P.MAX_READ, M.PARAM_COUNT - a);
    this.sweepAddr = a + n >= M.PARAM_COUNT ? M.BLOCK.in.base : a + n;
    const index = this.sweepName;
    this.sweepName = (index + 1) % M.NAME_SLOTS;
    try {
      const reply = await this.request(P.encodeRead(range(a, n)), P.FN.READ);
      this.applyFresh(P.decodePairs(reply.payload));
      const name = await this.readName(index);
      if (name !== this.names[index]) {
        this.names[index] = name;
        this.emit('name', index, name);
      }
    } catch { /* the next sweep retries */ } finally {
      this.busy.sweep = false;
    }
  }

  async pollLive() {
    if (!this.connected || this.busy.live) return;
    // With nobody watching, a slow poll is enough to keep the link alive.
    const now = Date.now();
    if (!this.wantMeters && now - (this.lastLive || 0) < IDLE_INTERVAL) return;
    this.lastLive = now;
    this.busy.live = true;
    try {
      const reply = await this.request(P.encodeRead(LIVE_FAST), P.FN.READ);
      let changed = false;
      for (const [addr, value] of P.decodePairs(reply.payload)) {
        this.params[addr] = value;
        const i = (addr - M.METER_FIRST_ADDR) * 2;
        if (i < 0 || i + 1 >= this.meters.length) continue;
        if (this.meters[i] !== value >> 8 || this.meters[i + 1] !== (value & 0xff)) changed = true;
        this.meters[i] = value >> 8;
        this.meters[i + 1] = value & 0xff;
      }
      if (changed || now - (this.lastMeterEmit || 0) > 1000) {
        this.lastMeterEmit = now;
        this.emit('meters', this.meters);
      }
    } catch { /* timeouts are counted in pump() */ } finally {
      this.busy.live = false;
    }
  }

  async pollStatus() {
    if (!this.synced || this.busy.status) return;
    this.busy.status = true;
    const now = Date.now();
    for (const [a, until] of this.hot) if (until < now) this.hot.delete(a);
    const addrs = [...LIVE_SLOW, ...this.hot.keys()];
    try {
      for (let i = 0; i < addrs.length; i += P.MAX_READ) {
        const reply = await this.request(P.encodeRead(addrs.slice(i, i + P.MAX_READ)), P.FN.READ);
        for (const [addr, value] of P.decodePairs(reply.payload)) if (addr < M.PARAM_COUNT) this.params[addr] = value;
      }
    } catch { /* next round */ } finally {
      this.busy.status = false;
    }
  }

  // The original interface is reading these: keep them fresh for a while.
  // Only addresses outside the announced settings need it.
  touch(addrs) {
    const until = Date.now() + HOT_TIME;
    for (const a of addrs) {
      if (a < 64 || a >= M.PARAM_COUNT || (a >= 2269 && a <= 2283)) continue;
      if (M.classify(a) === null && this.hot.size < 240) this.hot.set(a, until);
    }
  }

  // --- writes ------------------------------------------------------------
  // Queue parameter writes. Rapid changes to one address collapse into the
  // latest value. `raw` skips the range checks: it is for the original
  // interface, which enforces its own. Returns the pairs actually accepted.
  set(pairs, origin = null, raw = false) {
    const accepted = [];
    for (const [addr, value0] of pairs) {
      if (!Number.isInteger(addr) || !Number.isInteger(value0) || addr < 0 || addr >= M.PARAM_COUNT) continue;
      const value = raw ? value0 & 0xffff : M.sanitize(addr, value0, (a) => this.params[a]);
      if (value === null) continue;
      this.params[addr] = value;
      this.pendingWrites.set(addr, value);
      if (HELD.has(addr)) this.held.set(addr, value);
      accepted.push([addr, value]);
    }
    if (accepted.length) {
      this.remember();
      this.emit('params', accepted, origin);
    }
    return accepted;
  }

  async flushWrites() {
    if ((!this.synced && !this.resuming) || this.busy.write || !this.pendingWrites.size) return;
    this.busy.write = true;
    const batch = [...this.pendingWrites.entries()].slice(0, P.MAX_WRITE);
    const now = Date.now();
    for (const [addr] of batch) {
      this.pendingWrites.delete(addr);
      this.lastWrite.set(addr, now);
    }
    try {
      await this.request(P.encodeWrite(batch), P.FN.WRITE, true);
      // Some writes make the mixer change other settings: read those back.
      const follow = batch.flatMap(([addr]) => M.follows(addr));
      if (follow.length) for (const delay of [120, 500]) this.timers.push(setTimeout(() => this.readBack(follow), delay));
    } catch (err) {
      // Keep the values for the next attempt unless newer ones arrived.
      for (const [addr, value] of batch) if (!this.pendingWrites.has(addr)) this.pendingWrites.set(addr, value);
    } finally {
      this.busy.write = false;
    }
  }

  // Bring the mixer to the settings of a saved configuration. Only what
  // differs is written. Returns how many settings were changed.
  applySnapshot(params) {
    const pairs = [];
    for (let a = M.BLOCK.in.base; a < M.PARAM_COUNT; a++) {
      if (!isSetting(a)) continue;
      // Known settings are kept inside their limits; the rest goes back as it was read.
      const value = M.classify(a) ? (M.sanitize(a, params[a], (x) => params[x]) ?? params[a]) : params[a];
      if (value !== this.params[a]) pairs.push([a, value]);
    }
    return this.set(pairs, null, true).length;
  }

  async readBack(addrs) {
    try {
      const reply = await this.request(P.encodeRead(addrs), P.FN.READ, true);
      this.applyExternal(P.decodePairs(reply.payload));
    } catch { /* the sweep gets there later */ }
  }

  async setName(index, text) {
    if (!Number.isInteger(index) || index < 0 || index >= M.NAME_SLOTS) throw new Error('bad name slot');
    const clean = truncateUtf8(String(text).replace(/[\x00-\x1f]/g, '').trim(), M.NAME_MAX_BYTES);
    await this.request(P.encodeIndexed(P.FN.SET_NAME, index, clean), P.FN.SET_NAME, true);
    this.names[index] = clean;
    return clean;
  }
}

function range(start, count) {
  return Array.from({ length: count }, (_, i) => start + i);
}

function truncateUtf8(text, maxBytes) {
  let out = '';
  let bytes = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > maxBytes) break;
    out += ch;
    bytes += n;
  }
  return out;
}

module.exports = { Mixer };
