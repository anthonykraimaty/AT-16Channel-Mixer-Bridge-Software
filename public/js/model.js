// Parameter map of the SY-X16, shared by the server (validation) and the UI.
//
// The mixer exposes a flat table of 16-bit parameters. Inputs, buses and FX
// returns each occupy fixed-size blocks; a strip on screen drives one block
// (mono) or several (stereo pairs).
(function (root, factory) {
  const model = factory();
  if (typeof module === 'object' && module.exports) module.exports = model;
  else root.MixerModel = model;
})(typeof self !== 'undefined' ? self : this, function () {
  const PARAM_COUNT = 2607;

  const BLOCK = {
    in: { base: 64, size: 58, count: 26 },
    bus: { base: 1572, size: 48, count: 10 },
    fx: { base: 2088, size: 45, count: 2 },
  };

  // Offsets inside a block. `eq` is the first of `bands` groups of four
  // (type, freq, gain, q).
  const OFFSET = {
    in: {
      phantom: 1, gateOn: 2, gateThr: 3, gain: 4, phase: 5, on: 6, pan: 7, fader: 8, soloL: 19, soloR: 20,
      compOn: 25, ratio: 26, attack: 27, release: 28, compThr: 29, eqOn: 32, hpFreq: 35, lpFreq: 37, eq: 38, bands: 4,
    },
    bus: {
      fader: 0, phase: 1, on: 2, fbc: 3, delay: 5, compOn: 6, ratio: 7, attack: 8, release: 9, compThr: 10,
      soloL: 12, soloR: 13, eqOn: 14, hpFreq: 17, lpFreq: 19, eq: 20, bands: 7,
    },
    fx: { fader: 0, on: 1, soloL: 12, soloR: 13, eqOn: 14, hpFreq: 17, lpFreq: 19, eq: 20, bands: 4, effect: 40, fxA: 41, fxB: 42 },
  };

  // Where each send level sits. The mixer family has eight AUX buses; the X16
  // uses six, which is why the offsets are not contiguous.
  const SEND = {
    in: { aux1: 9, aux2: 10, aux3: 11, aux4: 12, aux5: 13, aux6: 14, mainL: 17, mainR: 18, fx1: 21, fx2: 22 },
    fx: { aux1: 2, aux2: 3, aux3: 4, aux4: 5, aux5: 6, aux6: 7, mainL: 10, mainR: 11 },
  };

  const LEVEL_MASK = 0x3fff;
  const FLAG_PRE = 0x8000;
  const LEVEL_MAX = 1300; // +10 dB
  const LEVEL_UNITY = 1200; // 0 dB

  // Input solo writes carry flag bits the mixer's own UI uses.
  const SOLO = {
    in: { on: 0x8000 | LEVEL_UNITY, off: 0x4000 | LEVEL_UNITY },
    bus: { on: LEVEL_UNITY, off: 0 },
    fx: { on: LEVEL_UNITY, off: 0 },
  };

  const FREQ_TENTHS = 0x8000;
  const HP_OFF = FREQ_TENTHS | 196; // 19.6 Hz, shown as OFF
  const LP_OFF = 20600;

  // Value limits enforced before anything is written: the mixer itself stores
  // whatever it is sent, so out-of-range values must be stopped here.
  // All taken from what the mixer's own interface allows.
  const RANGE = {
    fader: [0, LEVEL_MAX],
    send: [0, LEVEL_MAX],
    pan: [0, 200],
    gain: [0, 45], // dB
    eqGain: [380, 620], // 500 + dB x 10
    eqQ: [60, 2800], // Q x 100
    freq: [20, 20000], // Hz
    gateThr: [0, 120], // dB below zero
    compThr: [-800, 100], // dB x 10
    ratio: [10, 200], // ratio x 10
    attack: [30, 5000], // ms x 10
    release: [100, 50000], // ms x 10
    delay: [0, 400], // ms x 10
    fbc: [0, 3], // 0 = off, then strength
  };

  // --- effects -----------------------------------------------------------
  // Each effect has two settings. `scale` turns the stored number into the
  // unit shown; limits are the ones the mixer's own interface stops at.
  const FX_SETTING = {
    preDelay: { label: 'Pre-delay', unit: 'ms', scale: 1, digits: 0, range: [0, 30] },
    duration: { label: 'Duration', unit: 's', scale: 0.1, digits: 1, range: [0, 100] },
    echoDelay: { label: 'Delay', unit: 'ms', scale: 5, digits: 0, range: [0, 68] },
    repeat: { label: 'Repeat', unit: '%', scale: 1, digits: 0, range: [0, 100] },
    gateReverb: { label: 'Reverb', unit: 's', scale: 0.1, digits: 1, range: [0, 100] },
    gateEcho: { label: 'Echo', unit: '%', scale: 1, digits: 0, range: [0, 100] },
    slope: { label: 'Slope', unit: '', scale: 1, digits: 0, range: [0, 63] },
    rate: { label: 'Rate', unit: 'Hz', scale: 1, digits: 0, range: [0, 42] },
    depth: { label: 'Depth', unit: '%', scale: 1, digits: 0, range: [0, 100] },
  };
  const reverb = ['preDelay', 'duration'], echo = ['echoDelay', 'repeat'], sweep = ['rate', 'depth'];
  const EFFECTS = [
    ['Reverb Hall', reverb], ['Reverb Room', reverb], ['Reverb Plate', reverb], ['Reverb Vocal 1', reverb],
    ['Reverb Vocal 2', reverb], ['Vocal Echo 1', echo], ['Vocal Echo 2', echo], ['Delay 1', echo],
    ['Delay 2', echo], ['Mod. Delay', echo], ['Reverb Gate', ['gateReverb', 'gateEcho']], ['Pitch Change', ['slope', 'depth']],
    ['Chorus', sweep], ['Phaser', sweep], ['Flange', sweep], ['Tremolo', sweep],
  ].map(([name, settings], i) => ({ number: i + 1, name, settings: settings.map((key) => FX_SETTING[key]) }));

  // An effect is chosen by writing its number (1..16) to the unit's select
  // address. The mixer then loads the settings it remembers for that effect
  // into the unit's block, and keeps remembering them as they are changed.
  const FX_SELECT = [2257, 2258];
  // Its memory: five numbers per effect (number, setting A, setting B, two unused).
  const FX_TABLE = [2284, 2445];
  // The second unit counts its effects from 17.
  const effectOf = (stored) => EFFECTS[(((stored - 1) % 16) + 16) % 16];
  const fxMemory = (unit, number, setting) => FX_TABLE[unit] + (number - 1) * 5 + 1 + setting;

  const STRIPS = [];
  // The mixer meters every input in three places: at the input, after the
  // EQ, and after the compressor just before the fader. The first reads about
  // 6 dB lower than the other two for the same signal. Strips show the last
  // one: it is what goes into the mix, and it is on the same scale as the
  // output meters, so a channel and the outputs it feeds agree.
  const METER_AFTER_EQ = 26, METER_PRE_FADER = 52;
  const input = (n) => STRIPS.push({ id: `ch${n}`, kind: 'input', label: `CH${n}`, type: 'in', blocks: [n - 1], nameSlots: [n - 1], meters: [METER_PRE_FADER + n - 1], inputMeters: [n - 1], phantom: true });
  for (let n = 1; n <= 12; n++) input(n);
  STRIPS.push({ id: 'ch13', kind: 'input', label: 'CH13/14', type: 'in', blocks: [12, 13, 14, 15], left: [12, 14], right: [13, 15], nameSlots: [12], meters: [METER_PRE_FADER + 14, METER_PRE_FADER + 15], inputMeters: [14, 15] });
  STRIPS.push({ id: 'pc', kind: 'input', label: 'PC/MP3', type: 'in', blocks: [24, 25], left: [24], right: [25], nameSlots: [24], meters: [METER_PRE_FADER + 24, METER_PRE_FADER + 25], inputMeters: [24, 25] });
  STRIPS.push({ id: 'fx1', kind: 'fx', label: 'FX1', type: 'fx', blocks: [0], nameSlots: [36], meters: [78, 79], send: ['fx1'] });
  STRIPS.push({ id: 'fx2', kind: 'fx', label: 'FX2', type: 'fx', blocks: [1], nameSlots: [37], meters: [80, 81], send: ['fx2'] });
  for (let n = 1; n <= 4; n++) STRIPS.push({ id: `aux${n}`, kind: 'aux', label: `AUX${n}`, type: 'bus', blocks: [n - 1], nameSlots: [25 + n], meters: [81 + n], send: [`aux${n}`] });
  STRIPS.push({ id: 'aux5', kind: 'aux', label: 'AUX5/6', type: 'bus', blocks: [4, 5], left: [4], right: [5], nameSlots: [30], meters: [86, 87], send: ['aux5', 'aux6'] });
  STRIPS.push({ id: 'main', kind: 'main', label: 'MAIN', type: 'bus', blocks: [8, 9], left: [8], right: [9], nameSlots: [34], meters: [90, 91] });

  const BY_ID = Object.fromEntries(STRIPS.map((s) => [s.id, s]));

  // Mixes a source can be sent to, besides MAIN. FX returns feed the monitors
  // too, but an FX return is never offered as a source of an FX send.
  const MIXES = STRIPS.filter((s) => s.send).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'aux' ? -1 : 1)).map((s) => s.id);
  const isSource = (strip, mixId) => (strip.kind === 'input' || (strip.kind === 'fx' && BY_ID[mixId].kind === 'aux'));
  const has = (strip, key) => OFFSET[strip.type][key] !== undefined;

  const addr = (type, block, offset) => BLOCK[type].base + BLOCK[type].size * block + offset;

  // Levels that have a physical fader on the mixer. The faders are not
  // motorised: when the last network client leaves, the mixer falls back to
  // where they physically stand, so these values have to be held and put back.
  const HELD = [];
  for (const s of STRIPS) {
    if (s.kind !== 'input' && s.kind !== 'main') continue;
    for (const b of s.blocks) HELD.push(addr(s.type, b, OFFSET[s.type].fader));
  }

  // Every address a strip-level parameter lives at (one per block).
  function addrs(strip, key) {
    const off = OFFSET[strip.type][key];
    if (off === undefined) return [];
    return strip.blocks.map((b) => addr(strip.type, b, off));
  }

  function sendAddrs(strip, mixId) {
    const map = SEND[strip.type];
    if (!map) return [];
    const out = [];
    for (const b of strip.blocks) {
      for (const name of BY_ID[mixId].send) if (map[name] !== undefined) out.push(addr(strip.type, b, map[name]));
    }
    return out;
  }

  function eqAddrs(strip, band, field) {
    const o = OFFSET[strip.type];
    const f = { type: 0, freq: 1, gain: 2, q: 3 }[field];
    return strip.blocks.map((b) => addr(strip.type, b, o.eq + band * 4 + f));
  }

  // Address/value pairs that switch a strip's solo on or off. Stereo strips
  // feed their left blocks to solo-left only and right blocks to solo-right.
  function soloPairs(strip, on) {
    const o = OFFSET[strip.type];
    const v = on ? SOLO[strip.type].on : SOLO[strip.type].off;
    const pairs = [];
    for (const b of strip.blocks) {
      const toL = !strip.right || !strip.right.includes(b);
      const toR = !strip.left || !strip.left.includes(b);
      pairs.push([addr(strip.type, b, o.soloL), toL ? v : 0]);
      pairs.push([addr(strip.type, b, o.soloR), toR ? v : 0]);
    }
    return pairs;
  }

  function isSoloed(strip, get) {
    const o = OFFSET[strip.type];
    const b = strip.blocks[0];
    const v = get(addr(strip.type, b, o.soloL));
    const level = (v & LEVEL_MASK) > 0;
    return strip.type === 'in' ? level && (v & 0x8000) !== 0 : level;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // --- value conversions -------------------------------------------------
  const levelToDb = (v) => ((v & LEVEL_MASK) === 0 ? -Infinity : (v & LEVEL_MASK) / 10 - 120);
  const dbToLevel = (db) => (db === -Infinity ? 0 : clamp(Math.round((db + 120) * 10), 1, LEVEL_MAX));

  // Fader travel (0..1) to dB. Piecewise linear, with most of the travel
  // spent between -20 and +10 dB like a physical fader.
  const TAPER = [[0, -90], [0.05, -60], [0.11, -50], [0.18, -40], [0.27, -30], [0.39, -20], [0.54, -10], [0.64, -5], [0.75, 0], [0.875, 5], [1, 10]];
  function posToLevel(pos) {
    const p = clamp(pos, 0, 1);
    if (p <= 0.004) return 0;
    for (let i = 1; i < TAPER.length; i++) {
      if (p <= TAPER[i][0]) {
        const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
        return dbToLevel(d0 + ((p - p0) / (p1 - p0)) * (d1 - d0));
      }
    }
    return LEVEL_MAX;
  }
  function levelToPos(v) {
    const db = levelToDb(v);
    if (db === -Infinity || db <= TAPER[0][1]) return 0;
    for (let i = 1; i < TAPER.length; i++) {
      if (db <= TAPER[i][1]) {
        const [p0, d0] = TAPER[i - 1], [p1, d1] = TAPER[i];
        return p0 + ((db - d0) / (d1 - d0)) * (p1 - p0);
      }
    }
    return 1;
  }
  const dbToPos = (db) => levelToPos(dbToLevel(db));

  const decodeFreq = (v) => (v & FREQ_TENTHS ? (v & 0x7fff) / 10 : v);
  const encodeFreq = (hz) => (hz < 100 ? FREQ_TENTHS | Math.round(hz * 10) : Math.round(hz));

  // Negative numbers are stored as sign and magnitude, not two's complement.
  const decodeSigned = (v) => (v & 0x8000 ? -(v & 0x7fff) : v);
  const encodeSigned = (n) => (n < 0 ? 0x8000 | -n : n);

  // Meter bytes count half-decibels below full scale; 181 is the idle floor.
  // Meters. The mixer sends two per address: the even-numbered meter in the
  // low byte, the odd-numbered one in the high byte. The bridge passes the
  // bytes on in wire order (high byte first), hence the swap.
  //   0..25  inputs by block, at the input      78/79, 80/81  FX1, FX2 (left, right)
  //   26..51 the same, after the EQ             82..89        AUX1..8
  //   52..77 the same, after the compressor     90, 91        MAIN L, R
  const meterIndex = (meter) => meter ^ 1;
  // A meter byte is the level in dB as a signed number. 0 dB is the nominal
  // level, not the limit: the mixer's own meter goes on to +14. The idle
  // value 0xb5 (181) is -75 dB.
  const METER_FLOOR = 181;
  const meterToDb = (byte) => (byte > 127 ? byte - 256 : byte);
  // Height of the bar for a level, following the twelve steps of the mixer's
  // own meter (each a twelfth of the height), with ten more dB below them.
  const METER_STEPS = [-30, -25, -20, -15, -10, -7, -4, -2, 0, 5, 10, 14];
  const METER_BOTTOM = -40;
  function meterToPos(db) {
    if (db <= METER_BOTTOM) return 0;
    let below = METER_BOTTOM;
    for (let i = 0; i < METER_STEPS.length; i++) {
      if (db <= METER_STEPS[i]) return (i + (db - below) / (METER_STEPS[i] - below)) / 12;
      below = METER_STEPS[i];
    }
    return 1;
  }
  // Where the colours change, as on the mixer: green up to 0 dB, yellow up to
  // +10, red above.
  const METER_YELLOW = 0, METER_RED = 10;

  // --- write validation --------------------------------------------------
  // What of an effect may be written: the choice, and the two settings.
  // The effect number in the block and the memory table are the mixer's own.
  function fxSlot(a) {
    const unit = FX_SELECT.indexOf(a);
    if (unit !== -1) return { unit, kind: 'select' };
    const { base, size, count } = BLOCK.fx;
    if (a < base || a >= base + size * count) return null;
    const off = (a - base) % size;
    if (off !== OFFSET.fx.fxA && off !== OFFSET.fx.fxB) return null;
    return { unit: Math.floor((a - base) / size), kind: 'setting', setting: off - OFFSET.fx.fxA };
  }

  // `get` reads the current value of an address; it tells which effect is on.
  function sanitizeFx(slot, v, get) {
    if (slot.kind === 'select') return v >= 1 && v <= 16 ? v : null;
    if (!get) return null;
    const effect = effectOf(get(addr('fx', slot.unit, OFFSET.fx.effect)));
    return clamp(v, ...effect.settings[slot.setting].range);
  }

  // Addresses the mixer changes by itself after `a` was written, to be read
  // back: choosing an effect replaces its number and both settings.
  function follows(a) {
    const unit = FX_SELECT.indexOf(a);
    if (unit === -1) return [];
    return [OFFSET.fx.effect, OFFSET.fx.fxA, OFFSET.fx.fxB].map((off) => addr('fx', unit, off));
  }

  const FLAGS = ['on', 'phantom', 'phase', 'gateOn', 'compOn', 'eqOn'];
  const RANGED = ['pan', 'gain', 'gateThr', 'ratio', 'attack', 'release', 'delay', 'fbc'];

  // Classify an address so a write can be clamped or refused.
  function classify(a) {
    if (fxSlot(a)) return 'fx';
    for (const type of ['in', 'bus', 'fx']) {
      const { base, size, count } = BLOCK[type];
      if (a < base || a >= base + size * count) continue;
      const off = (a - base) % size;
      const o = OFFSET[type];
      if (off === o.fader) return 'fader';
      if (off === o.soloL || off === o.soloR) return 'solo';
      if (off === o.compThr) return 'compThr';
      if (off === o.hpFreq || off === o.lpFreq) return 'filterFreq';
      for (const key of FLAGS) if (off === o[key]) return 'flag';
      for (const key of RANGED) if (off === o[key]) return key;
      if (SEND[type] && Object.values(SEND[type]).includes(off)) return 'send';
      if (off >= o.eq && off < o.eq + o.bands * 4) return ['eqType', 'eqFreq', 'eqGain', 'eqQ'][(off - o.eq) % 4];
      return null;
    }
    return null;
  }

  // Returns the value to write, or null when the write must be refused.
  function sanitize(a, value, get) {
    const v = value & 0xffff;
    const kind = classify(a);
    switch (kind) {
      case null: return null;
      case 'fx': return sanitizeFx(fxSlot(a), v, get);
      case 'fader': return clamp(v, ...RANGE.fader);
      case 'flag': return v ? 1 : 0;
      case 'send': return (v & FLAG_PRE) | clamp(v & LEVEL_MASK, ...RANGE.send);
      case 'solo': return [0, LEVEL_UNITY, SOLO.in.on, SOLO.in.off].includes(v) ? v : null;
      case 'compThr': return encodeSigned(clamp(decodeSigned(v), ...RANGE.compThr));
      case 'eqType': return null;
      case 'eqGain': return clamp(v, ...RANGE.eqGain);
      case 'eqQ': return clamp(v, ...RANGE.eqQ);
      case 'eqFreq': return encodeFreq(clamp(decodeFreq(v), ...RANGE.freq));
      case 'filterFreq': return v === HP_OFF || v === LP_OFF ? v : encodeFreq(clamp(decodeFreq(v), ...RANGE.freq));
      default: return RANGE[kind][1] > RANGE[kind][0] ? clamp(v, ...RANGE[kind]) : null;
    }
  }

  return {
    PARAM_COUNT, BLOCK, OFFSET, SEND, STRIPS, BY_ID, MIXES, RANGE, HELD, EFFECTS, FX_SELECT, effectOf, fxMemory, follows,
    LEVEL_MASK, LEVEL_MAX, LEVEL_UNITY, FLAG_PRE, HP_OFF, LP_OFF, METER_FLOOR,
    NAME_SLOTS: 40, NAME_MAX_BYTES: 31, METER_FIRST_ADDR: 2, METER_ADDR_COUNT: 47,
    addr, addrs, sendAddrs, eqAddrs, soloPairs, isSoloed, isSource, has, clamp,
    levelToDb, dbToLevel, posToLevel, levelToPos, dbToPos,
    decodeFreq, encodeFreq, decodeSigned, encodeSigned, meterToDb, meterIndex, meterToPos, METER_YELLOW, METER_RED,
    classify, sanitize, METER_AFTER_EQ, METER_PRE_FADER,
  };
});
