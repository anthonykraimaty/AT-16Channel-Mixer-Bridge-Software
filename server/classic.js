// The mixer's original web interface, served through this machine.
//
//   /classic/         shares the bridge's connection to the mixer. Reads are
//                     answered from the bridge's mirror, so the page keeps
//                     working through a connection drop and reconnects on
//                     its own. Does not use up one of the mixer's three slots.
//   /classic-direct/  the plain relay: one mixer connection per page, every
//                     frame passed through untouched.
const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const P = require('./protocol');
const M = require('../public/js/model');

// Replaces the page's WebSocket with one that points at the bridge and
// quietly reconnects. The page never notices a short interruption; if it
// does give up, it is reloaded once the bridge answers again.
const shim = (socketPath) => `<script>(function(){
var Native=window.WebSocket;
var url=(location.protocol==='https:'?'wss://':'ws://')+location.host+'${socketPath}';
function Link(){
  this.readyState=0;this.binaryType='arraybuffer';this.protocol='';this.extensions='';this.bufferedAmount=0;this.url=url;
  this.onopen=this.onmessage=this.onclose=this.onerror=null;
  this._done=false;this._opened=false;this._tries=0;this._open();
}
Link.prototype._open=function(){
  var self=this,s=new Native(url);s.binaryType='arraybuffer';this._s=s;
  s.onopen=function(e){self._tries=0;self.readyState=1;if(!self._opened){self._opened=true;if(self.onopen)self.onopen(e)}};
  s.onmessage=function(e){if(self.onmessage)self.onmessage(e)};
  s.onerror=function(){};
  s.onclose=function(){if(self._done)return;self._tries++;setTimeout(function(){if(!self._done)self._open()},Math.min(300*self._tries,2000))};
};
Link.prototype.send=function(d){if(this._s&&this._s.readyState===1)this._s.send(d)};
Link.prototype.close=function(){
  if(this._done)return;this._done=true;this.readyState=3;
  try{this._s.close()}catch(e){}
  if(this.onclose)this.onclose({wasClean:true,code:1000,reason:''});
  // The page has given up on the mixer: start it again when the bridge is back.
  (function retry(){fetch(location.href,{method:'HEAD',cache:'no-store'}).then(function(){location.reload()},function(){setTimeout(retry,1500)})})();
};
Link.prototype.addEventListener=function(t,f){this['on'+t]=f};
Link.prototype.removeEventListener=function(t){this['on'+t]=null};
Link.CONNECTING=0;Link.OPEN=1;Link.CLOSING=2;Link.CLOSED=3;
window.WebSocket=Link;
})();</script>`;

class Classic {
  constructor({ mixer, host, port, cacheFile }) {
    this.mixer = mixer;
    this.host = host;
    this.port = port;
    this.cacheFile = cacheFile;
    this.html = null;
    this.loading = null;
    this.clients = new Set();

    mixer.on('foreign', (frame) => this.broadcast(frame));
    mixer.on('params', (pairs, origin) => this.announce(pairs, origin));
  }

  // --- page --------------------------------------------------------------
  fetchPage() {
    return new Promise((resolve, reject) => {
      const req = http.get({ host: this.host, port: 80, path: '/', timeout: 8000 }, (res) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`mixer answered ${res.statusCode}`)); }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
    });
  }

  async getPage() {
    if (this.html) return this.html;
    if (!this.loading) {
      this.loading = (async () => {
        let html;
        try {
          html = await this.fetchPage();
          fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
          fs.writeFileSync(this.cacheFile, html);
        } catch (err) {
          // Mixer unreachable: fall back to the copy saved last time.
          html = fs.readFileSync(this.cacheFile, 'utf8');
        }
        this.html = html;
        return html;
      })().finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  async serve(res, socketPath) {
    try {
      const page = (await this.getPage()).replace('<head>', `<head>${shim(socketPath)}`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8', 'Cache-Control': 'no-cache' });
      res.end(page);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=UTF-8' });
      res.end(`The original interface could not be loaded from the mixer at ${this.host}: ${err.message}`);
    }
  }

  // --- shared connection ---------------------------------------------------
  attach(client) {
    this.clients.add(client);
    this.emitCount();
    client.on('message', (data) => {
      try { this.handle(client, data); } catch (err) { /* a malformed frame must not take the bridge down */ }
    });
    client.on('close', () => { this.clients.delete(client); this.emitCount(); });
    client.on('error', () => {});
  }

  emitCount() {
    if (this.onCount) this.onCount(this.clients.size);
  }

  reply(client, frame) {
    if (client.readyState === WebSocket.OPEN) client.send(frame, { binary: true });
  }

  handle(client, data) {
    const mixer = this.mixer;
    const msg = P.decode(data);
    // Until the first sync there is nothing to answer with; the page retries.
    if (!msg || !mixer.everSynced) return;
    const p = msg.payload;

    switch (msg.fn) {
      case P.FN.READ: {
        const addrs = [];
        for (let i = 0; i + 1 < p.length; i += 2) addrs.push(p.readUInt16BE(i));
        mixer.touch(addrs);
        const out = Buffer.alloc(addrs.length * 4);
        addrs.forEach((a, i) => {
          out.writeUInt16BE(a, i * 4);
          out.writeUInt16BE(a < M.PARAM_COUNT ? mixer.params[a] : 0, i * 4 + 2);
        });
        this.reply(client, P.encode(P.FN.READ, out));
        break;
      }
      case P.FN.WRITE:
        mixer.set(P.decodePairs(p), client, true);
        this.reply(client, data);
        break;
      case P.FN.PUSH:
        break; // acknowledgement of something we announced
      case P.FN.NAME:
        this.reply(client, P.encodeIndexed(P.FN.NAME, p[0], mixer.names[p[0]] || ''));
        break;
      case P.FN.SET_NAME: {
        const { index, text } = P.decodeIndexed(p);
        mixer.setName(index, text).then((clean) => {
          this.reply(client, data);
          mixer.emit('name', index, clean);
        }, () => {});
        break;
      }
      case P.FN.SCENE_NAME:
        this.reply(client, P.encodeIndexed(P.FN.SCENE_NAME, p[0], mixer.scenes[p[0] - 1] || ''));
        break;
      case P.FN.INFO:
        if (mixer.infoFrame) this.reply(client, mixer.infoFrame);
        break;
      default:
        // Scenes, media player, system settings...: the mixer's business.
        mixer.forward(data);
    }
  }

  // Tell the pages about changes made elsewhere, the way the mixer would.
  announce(pairs, origin) {
    if (!this.clients.size) return;
    for (let i = 0; i < pairs.length; i += P.MAX_WRITE) {
      const chunk = pairs.slice(i, i + P.MAX_WRITE);
      const payload = Buffer.alloc(chunk.length * 4);
      chunk.forEach(([a, v], k) => { payload.writeUInt16BE(a, k * 4); payload.writeUInt16BE(v, k * 4 + 2); });
      const frame = P.encode(P.FN.PUSH, payload);
      for (const client of this.clients) if (client !== origin) this.reply(client, frame);
    }
  }

  broadcast(frame) {
    for (const client of this.clients) this.reply(client, frame);
  }

  // --- plain relay ---------------------------------------------------------
  relay(client) {
    const upstream = new WebSocket(`ws://${this.host}:${this.port}/`, { perMessageDeflate: false, origin: `http://${this.host}` });
    const early = [];
    upstream.on('open', () => early.splice(0).forEach((d) => upstream.send(d, { binary: true })));
    upstream.on('message', (d) => { if (client.readyState === WebSocket.OPEN) client.send(d, { binary: true }); });
    client.on('message', (d) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(d, { binary: true }); else early.push(d); });
    upstream.on('close', () => client.close());
    client.on('close', () => upstream.terminate());
    upstream.on('error', () => client.close());
    client.on('error', () => upstream.terminate());
  }
}

module.exports = { Classic };
