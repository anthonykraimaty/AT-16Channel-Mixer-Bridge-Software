// A small JSON file written in the background: the fader levels the bridge
// holds, so that they survive a restart of the bridge as well.
const fs = require('fs');
const path = require('path');

const WRITE_DELAY = 500;

class Memory {
  constructor(file) {
    this.file = file;
    this.timer = null;
    this.data = null;
  }

  load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return null;
    }
  }

  save(data) {
    this.data = data;
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, WRITE_DELAY);
  }

  flush() {
    if (!this.data) return;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`could not save levels: ${err.message}`);
    }
  }
}

module.exports = { Memory };
