// Spectrum (RTA) of a sound card input of the PC, such as the mixer's USB
// sound card. AudioTap.exe records the input; this file turns the sound into
// levels per frequency band and hands them to the screens that show them.
// The mixer itself sends no sound over the network, so this works only on
// the PC with a cable to the mixer.
'use strict';

const { EventEmitter } = require('events');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TAP = path.join(__dirname, '..', 'AudioTap.exe');
const FFT_SIZE = 8192;
const FRAMES_PER_SECOND = 15;
// Bands of one sixth of an octave from 20 Hz to 20 kHz.
const BANDS_PER_OCTAVE = 6;
const LOW_HZ = 20;
const BAND_COUNT = Math.round(Math.log2(20000 / LOW_HZ) * BANDS_PER_OCTAVE) + 1;
const FLOOR_DB = -100;
// How fast a band falls back once the sound in it stops, in dB a frame.
const FALL_DB = 2.5;
// Stop recording a while after the last screen stopped looking.
const IDLE_MS = 5000;

const supported = () => process.platform === 'win32' && fs.existsSync(TAP);

function bandHz(i) {
  return LOW_HZ * Math.pow(2, i / BANDS_PER_OCTAVE);
}

// In-place radix-2 FFT.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle), wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
}

class Rta extends EventEmitter {
  constructor() {
    super();
    this.device = '';
    this.watchers = new Set();
    this.child = null;
    this.rate = 48000;
    this.state = supported() ? 'off' : 'unsupported';
    this.message = '';
    this.ring = new Float32Array(FFT_SIZE);
    this.at = 0;
    this.levels = new Float32Array(BAND_COUNT).fill(FLOOR_DB);
    this.window = Float32Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
    this.windowSum = this.window.reduce((s, v) => s + v, 0);
    this.timer = null;
    this.idle = null;
  }

  info() {
    return { t: 'rtaState', state: this.state, device: this.device, message: this.message, bands: BAND_COUNT, lowHz: LOW_HZ, perOctave: BANDS_PER_OCTAVE };
  }

  list() {
    return new Promise((resolve) => {
      if (!supported()) { resolve([]); return; }
      execFile(TAP, ['--list'], { windowsHide: true, timeout: 5000 }, (err, out) => {
        resolve(err ? [] : out.split(/\r?\n/).filter(Boolean));
      });
    });
  }

  setDevice(name) {
    name = typeof name === 'string' ? name : '';
    if (name === this.device) return;
    this.device = name;
    this.stopTap();
    this.update();
  }

  watch(key, on) {
    if (on) this.watchers.add(key); else this.watchers.delete(key);
    this.update();
  }

  update() {
    const wanted = this.watchers.size > 0 && this.device && supported();
    if (wanted) {
      clearTimeout(this.idle);
      this.idle = null;
      if (!this.child) this.startTap();
    } else if (this.child && !this.idle) {
      this.idle = setTimeout(() => { this.idle = null; if (!this.watchers.size) this.stopTap(); }, IDLE_MS);
    } else if (!this.child) {
      this.setState(!supported() ? 'unsupported' : this.device ? 'off' : 'noDevice');
    }
  }

  setState(state, message = '') {
    if (state === this.state && message === this.message) return;
    this.state = state;
    this.message = message;
    this.emit('state', this.info());
  }

  startTap() {
    const child = spawn(TAP, ['--device', this.device], { windowsHide: true });
    this.child = child;
    this.levels.fill(FLOOR_DB);
    this.ring.fill(0);
    this.setState('starting');
    let rest = null;
    child.stdout.on('data', (chunk) => {
      if (child !== this.child) return;
      if (rest) { chunk = Buffer.concat([rest, chunk]); rest = null; }
      const usable = chunk.length & ~1;
      for (let i = 0; i < usable; i += 2) {
        this.ring[this.at] = chunk.readInt16LE(i) / 32768;
        this.at = (this.at + 1) % FFT_SIZE;
      }
      if (usable < chunk.length) rest = chunk.subarray(usable);
      if (this.state !== 'on') this.setState('on');
    });
    let errors = '';
    child.stderr.on('data', (d) => {
      errors += d.toString();
      const rate = /rate (\d+)/.exec(errors);
      if (rate) this.rate = Number(rate[1]);
    });
    child.stdin.on('error', () => {});
    child.on('error', (err) => this.lost(child, err.message));
    child.on('exit', () => {
      const why = errors.split(/\r?\n/).find((l) => l && !l.startsWith('rate '));
      this.lost(child, why ? (why.startsWith('missing') ? 'The sound card is not connected.' : why) : '');
    });
    this.timer = setInterval(() => this.frame(), 1000 / FRAMES_PER_SECOND);
  }

  // The helper ended without being asked: card unplugged, or no access.
  lost(child, message) {
    if (child !== this.child) return;
    this.child = null;
    clearInterval(this.timer);
    this.timer = null;
    this.setState('error', message || 'The sound card stopped.');
    // Try again in a while, for a card that was plugged back in.
    setTimeout(() => { if (!this.child && this.state === 'error') this.update(); }, 5000);
  }

  stopTap() {
    const child = this.child;
    this.child = null;
    clearInterval(this.timer);
    this.timer = null;
    if (child) {
      try { child.stdin.end(); } catch { /* already gone */ }
      setTimeout(() => { if (child.exitCode === null) child.kill(); }, 1000);
    }
    this.setState(!supported() ? 'unsupported' : this.device ? 'off' : 'noDevice');
  }

  frame() {
    const re = new Float64Array(FFT_SIZE);
    const im = new Float64Array(FFT_SIZE);
    for (let i = 0; i < FFT_SIZE; i++) re[i] = this.ring[(this.at + i) % FFT_SIZE] * this.window[i];
    fft(re, im);
    // Level of a full-scale sine reads 0 dB.
    const scale = 2 / this.windowSum;
    const binHz = this.rate / FFT_SIZE;
    const power = (k) => (re[k] * re[k] + im[k] * im[k]) * scale * scale;
    const out = new Array(BAND_COUNT);
    for (let b = 0; b < BAND_COUNT; b++) {
      const centre = bandHz(b);
      const lo = centre / Math.pow(2, 1 / (2 * BANDS_PER_OCTAVE));
      const hi = centre * Math.pow(2, 1 / (2 * BANDS_PER_OCTAVE));
      const k0 = Math.ceil(lo / binHz), k1 = Math.floor(hi / binHz);
      let p = 0;
      if (k1 >= k0) {
        for (let k = k0; k <= k1 && k < FFT_SIZE / 2; k++) p += power(k);
        // The window spreads a tone over 1.5 bins' worth of power.
        p /= 1.5;
      } else {
        // Low bands are narrower than one bin: take the bin they fall in.
        p = power(Math.min(Math.round(centre / binHz), FFT_SIZE / 2 - 1));
      }
      const db = p > 0 ? Math.max(10 * Math.log10(p), FLOOR_DB) : FLOOR_DB;
      this.levels[b] = Math.max(db, this.levels[b] - FALL_DB);
      out[b] = Math.round(this.levels[b]);
    }
    this.emit('frame', out);
  }

  close() {
    this.watchers.clear();
    clearTimeout(this.idle);
    this.stopTap();
  }
}

module.exports = { Rta };

// As a command line tool: node server/rta.js [device] prints the loudest band.
if (require.main === module) {
  const rta = new Rta();
  rta.list().then((names) => {
    const device = process.argv[2] || names[0];
    console.log('devices:', names);
    if (!device) return;
    rta.setDevice(device);
    rta.on('state', (s) => console.log('state', s.state, s.message));
    rta.on('frame', (b) => {
      const top = b.indexOf(Math.max(...b));
      process.stdout.write(`\rloudest ${Math.round(bandHz(top))} Hz at ${b[top]} dB   `);
    });
    rta.watch('cli', true);
    setTimeout(() => { rta.close(); console.log(); }, 3000);
  });
}
