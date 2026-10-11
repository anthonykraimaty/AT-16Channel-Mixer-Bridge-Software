// Saved configurations: a complete picture of the mixer (every setting and
// name) together with the colours, views and mix sources kept by the bridge.
// One JSON file each, in data/configs.
const fs = require('fs');
const path = require('path');
const M = require('../public/js/model');

const FORMAT = 'mixer-bridge-config';
const MAX_CONFIGS = 200;
const ID = /^[a-z0-9]{6,24}$/;

const cleanName = (text) => String(text ?? '').replace(/[\x00-\x1f]/g, '').trim().slice(0, 60);

// Checks a configuration that came from outside (a file someone picked).
// Returns a tidy copy, or throws with a reason a person can read.
function validate(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== FORMAT) throw new Error('This is not a configuration saved by the mixer bridge.');
  if (!Array.isArray(raw.params) || raw.params.length !== M.PARAM_COUNT) throw new Error('The file does not match this mixer.');
  if (!raw.params.every((v) => Number.isInteger(v) && v >= 0 && v <= 0xffff)) throw new Error('The file contains values that are not valid.');
  const names = Array.isArray(raw.names) ? raw.names.slice(0, M.NAME_SLOTS).map((n) => String(n ?? '')) : [];
  while (names.length < M.NAME_SLOTS) names.push('');
  const look = raw.look && typeof raw.look === 'object' ? raw.look : {};
  return {
    format: FORMAT,
    version: 1,
    model: String(raw.model || ''),
    name: cleanName(raw.name) || 'Imported',
    savedAt: Number(raw.savedAt) || Date.now(),
    params: raw.params,
    names,
    look: {
      strips: look.strips && typeof look.strips === 'object' && !Array.isArray(look.strips) ? look.strips : {},
      views: Array.isArray(look.views) ? look.views : [],
      mixes: look.mixes && typeof look.mixes === 'object' && !Array.isArray(look.mixes) ? look.mixes : {},
    },
  };
}

class Configs {
  constructor(dir) {
    this.dir = dir;
  }

  file(id) {
    if (!ID.test(id)) throw new Error('bad id');
    return path.join(this.dir, `${id}.json`);
  }

  list() {
    let files = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const f of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (c.format === FORMAT) out.push({ id: f.slice(0, -5), name: c.name, savedAt: c.savedAt });
      } catch { /* a damaged file is left alone and not offered */ }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt);
  }

  read(id) {
    try { return validate(JSON.parse(fs.readFileSync(this.file(id), 'utf8'))); } catch { return null; }
  }

  // Saving under the name of an existing configuration replaces it.
  save(config) {
    const clean = validate({ ...config, format: FORMAT });
    const existing = this.list();
    const same = existing.find((c) => c.name.toLowerCase() === clean.name.toLowerCase());
    if (!same && existing.length >= MAX_CONFIGS) throw new Error('There are too many saved configurations. Delete some first.');
    const id = same ? same.id : Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file(id)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean));
    fs.renameSync(tmp, this.file(id));
    return { id, name: clean.name, replaced: Boolean(same) };
  }

  // A file picked by someone: it has to say what it is before it is stored.
  importFile(raw) {
    validate(raw);
    return this.save(raw);
  }

  remove(id) {
    try { fs.unlinkSync(this.file(id)); return true; } catch { return false; }
  }
}

module.exports = { Configs, cleanName };
