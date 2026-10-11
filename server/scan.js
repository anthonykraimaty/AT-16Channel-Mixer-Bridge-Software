// Looks for the mixer on the networks this computer is on. Every address of
// each network is tried on the mixer's control port; whatever answers there
// is asked what it is.
//   node server/scan.js [--prefer 192.168.0.144] [--port 8088]
// prints one line of JSON per event: network, progress, found, done.
const net = require('net');
const os = require('os');
const WebSocket = require('ws');
const P = require('./protocol');

const KNOCK_TIME = 700;
const ASK_TIME = 2000;
const AT_ONCE = 96;
// Networks that exist only inside this computer are searched last.
const VIRTUAL = /vethernet|wsl|hyper-v|virtual|vmware|vbox|tailscale|zerotier|docker|loopback/i;

// Never searched: the mobile network of a phone, and links to far places.
const FAR = /rmnet|ccmni|pdp|wwan|cell|ppp|tun|tailscale|zerotier/i;

const toNumber = (address) => address.split('.').reduce((n, part) => n * 256 + Number(part), 0);
const toAddress = (n) => [24, 16, 8, 0].map((shift) => Math.floor(n / 2 ** shift) % 256).join('.');

const isAddress = (text) => /^\d+\.\d+\.\d+\.\d+$/.test(text || '');

// The networks to search, each as a list of addresses; at most 254 of each.
// "addresses" are addresses of this device learned in another way, for where
// the networks cannot be listed (the Android app).
function networks(prefer, addresses = []) {
  const found = [];
  const seen = new Set();
  // Only home and venue networks: nothing out on the internet.
  const local = (address) => address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(address);
  let lists = {};
  try { lists = os.networkInterfaces(); } catch { /* not allowed on Android */ }
  for (const [name, list] of Object.entries(lists)) {
    for (const entry of list || []) {
      if (entry.family !== 'IPv4') continue;
      seen.add(entry.address);
      if (entry.internal || !local(entry.address) || FAR.test(name)) continue;
      const own = toNumber(entry.address);
      const mask = toNumber(entry.netmask || '255.255.255.0');
      const size = 2 ** 32 - mask;
      if (size < 4) continue;
      // A large network is searched only around this computer's own address.
      const first = size > 256 ? Math.floor(own / 256) * 256 : own - (own % size);
      const count = Math.min(size, 256);
      if (found.some((n) => n.first === first)) continue;
      const hosts = [];
      for (let n = first + 1; n < first + count - 1; n++) if (n !== own) hosts.push(toAddress(n));
      found.push({ name, first, own: entry.address, from: toAddress(first + 1), to: toAddress(first + count - 2), hosts, virtual: VIRTUAL.test(name) });
    }
  }
  for (const address of addresses) {
    if (!isAddress(address) || !local(address) || seen.has(address)) continue;
    const own = toNumber(address);
    const first = Math.floor(own / 256) * 256;
    if (found.some((n) => n.first === first)) continue;
    const hosts = [];
    for (let n = first + 1; n < first + 255; n++) if (n !== own) hosts.push(toAddress(n));
    found.push({ name: 'network', first, own: address, from: toAddress(first + 1), to: toAddress(first + 254), hosts, virtual: false });
  }
  const wanted = isAddress(prefer) ? prefer : null;
  const rank = (n) => (wanted && n.hosts.includes(wanted) ? 0 : n.virtual ? 2 : 1);
  return found.sort((a, b) => rank(a) - rank(b));
}

// Does anything listen on the port?
function knock(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const finish = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(KNOCK_TIME, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

// What is it? A mixer names its model. One that stays silent may be a mixer
// whose three connections are all taken.
function ask(host, port) {
  return new Promise((resolve) => {
    let done = false, open = false;
    const ws = new WebSocket(`ws://${host}:${port}/`, { perMessageDeflate: false, origin: `http://${host}`, handshakeTimeout: ASK_TIME });
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* never opened */ }
      setTimeout(() => { try { ws.terminate(); } catch { /* gone already */ } }, 300);
      resolve(result);
    };
    const timer = setTimeout(() => finish(open ? { silent: true } : null), ASK_TIME);
    ws.on('open', () => { open = true; ws.send(P.encode(P.FN.INFO, Buffer.from([0]))); });
    ws.on('message', (data) => {
      const frame = P.decode(data);
      if (!frame || frame.fn !== P.FN.INFO) return;
      finish({ model: frame.payload.subarray(5).toString('latin1').replace(/\0.*$/, '').replace(/[^\x20-\x7e]/g, '') });
    });
    ws.on('error', () => finish(null));
    ws.on('close', () => finish(open ? { silent: true } : null));
  });
}

// realOnly leaves out the networks that exist only inside this computer.
async function scan({ prefer, port = 8088, addresses, realOnly, onNetwork, onProgress, onFound } = {}) {
  const nets = networks(prefer, addresses).filter((n) => !(realOnly && n.virtual));
  const total = nets.reduce((n, one) => n + one.hosts.length, 0);
  const found = [];
  let done = 0;
  for (const one of nets) {
    // With a mixer in hand there is no need to look inside this computer too.
    if (one.virtual && found.some((entry) => entry.sure)) { done += one.hosts.length; continue; }
    if (onNetwork) onNetwork({ name: one.name, from: one.from, to: one.to });
    const queue = [...one.hosts];
    // The address in use now is tried first: most often it is still right.
    if (prefer && queue.includes(prefer)) queue.unshift(...queue.splice(queue.indexOf(prefer), 1));
    const worker = async () => {
      while (queue.length) {
        const host = queue.shift();
        if (await knock(host, port)) {
          const what = await ask(host, port);
          if (what) {
            const entry = { address: host, model: what.model || '', sure: !what.silent };
            found.push(entry);
            if (onFound) onFound(entry);
          }
        }
        done++;
        if (onProgress && (done % 8 === 0 || done === total)) onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, worker));
  }
  return found;
}

module.exports = { scan, networks };

if (require.main === module) {
  const arg = (name) => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : undefined; };
  const say = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  scan({
    prefer: arg('--prefer'),
    port: Number(arg('--port')) || 8088,
    onNetwork: (n) => say({ t: 'network', ...n }),
    onProgress: (done, total) => say({ t: 'progress', done, total }),
    onFound: (entry) => say({ t: 'found', ...entry }),
  }).then((found) => {
    say({ t: 'done', found: found.length });
    process.exit(0);
  }).catch((err) => {
    say({ t: 'error', message: err.message });
    process.exit(1);
  });
}
