// Settings the mixer has no place for: strip colours, custom views and the
// source selection of each monitor mix. Kept in one JSON file and shared by
// every device that opens the app.
const fs = require('fs');
const path = require('path');

const ROOTS = ['strips', 'views', 'mixes', 'options'];
const MAX_BYTES = 256 * 1024;

const DEFAULTS = {
  version: 1,
  // stripId -> { color }
  strips: {},
  // [{ id, name, strips: [stripId...] }]
  views: [],
  // mixId -> { hidden: [stripId...] }
  mixes: {},
  // holdLevels: put fader levels back after a connection drop (default on)
  options: {},
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    this.timer = null;
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of ROOTS) if (raw[key] && typeof raw[key] === 'object') this.data[key] = raw[key];
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`settings file unreadable, starting fresh: ${err.message}`);
    }
  }

  // Replace one top-level section or one entry of it, e.g.
  //   ['strips', 'ch1'] -> { color: '#e5484d' }
  //   ['views']         -> [ ... ]
  // A null value removes the entry. Returns false when the patch is refused.
  patch(keys, value) {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 2) return false;
    const [root, entry] = keys;
    if (!ROOTS.includes(root)) return false;
    if (entry !== undefined && (typeof entry !== 'string' || !/^[\w-]{1,40}$/.test(entry))) return false;
    if (JSON.stringify(value ?? null).length > MAX_BYTES) return false;

    if (entry === undefined) {
      if (value === null || typeof value !== 'object') return false;
      if (Array.isArray(value) !== Array.isArray(DEFAULTS[root])) return false;
      this.data[root] = value;
    } else {
      if (Array.isArray(this.data[root])) return false;
      if (value === null || value === undefined) delete this.data[root][entry];
      else this.data[root][entry] = value;
    }
    this.save();
    return true;
  }

  // Replace colours, views and mix sources in one go (loading a configuration).
  replaceLook(look) {
    this.data.strips = look.strips || {};
    this.data.views = look.views || [];
    this.data.mixes = look.mixes || {};
    this.save();
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const tmp = `${this.file}.tmp`;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.file);
      } catch (err) {
        console.warn(`could not save settings: ${err.message}`);
      }
    }, 300);
  }
}

module.exports = { Store };
