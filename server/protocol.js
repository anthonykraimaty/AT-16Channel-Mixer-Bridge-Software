// Wire protocol of the SY-X16 control WebSocket (port 8088).
//
// Every message is one binary WebSocket frame:
//   0x80 | len | fn | payload... | crc16
// len counts everything after itself (fn + payload + 2 crc bytes).
// crc16 is Modbus CRC-16 over all preceding bytes, stored high byte first
// (the reverse of the byte order Modbus itself uses on the wire).
//
// Functions seen so far:
//   0x00  device info            tx: 00            rx: 00 <ver..> "SY-X16\0"
//   0x03  write parameters       tx: (addr16 value16)+   rx: echo
//   0x04  scene name             tx: index         rx: index + ascii
//   0x06  read parameters        tx: addr16+       rx: (addr16 value16)+
//   0x25  change notification    rx: (addr16 value16)+   tx: echo (acknowledge)
//   0x2e  read strip name        tx: index         rx: index + text (empty = default)
//   0x2f  write strip name       tx: index + text  rx: echo (31 bytes are kept)
//   0x39  text config query      tx: "KEY="        rx: "KEY=value\n"
//   0x71  unsolicited status     rx only

const HEAD = 0x80;

const FN = {
  INFO: 0x00,
  WRITE: 0x03,
  SCENE_NAME: 0x04,
  READ: 0x06,
  PUSH: 0x25,
  NAME: 0x2e,
  SET_NAME: 0x2f,
  CONFIG: 0x39,
  STATUS: 0x71,
};

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

function crc16(buf, end = buf.length) {
  let c = 0xffff;
  for (let i = 0; i < end; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return c;
}

// Largest payload that fits the one-byte length field.
const MAX_PAYLOAD = 255 - 3;

function encode(fn, payload = Buffer.alloc(0)) {
  if (payload.length > MAX_PAYLOAD) throw new Error(`payload too long: ${payload.length}`);
  const out = Buffer.alloc(payload.length + 5);
  out[0] = HEAD;
  out[1] = payload.length + 3;
  out[2] = fn;
  Buffer.from(payload).copy(out, 3);
  const c = crc16(out, out.length - 2);
  out[out.length - 2] = c >>> 8;
  out[out.length - 1] = c & 0xff;
  return out;
}

function decode(data) {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (b.length < 5 || b[0] !== HEAD) return null;
  if (b[1] !== b.length - 2) return null;
  const c = crc16(b, b.length - 2);
  if (b[b.length - 2] !== c >>> 8 || b[b.length - 1] !== (c & 0xff)) return null;
  return { fn: b[2], payload: b.subarray(3, b.length - 2) };
}

// Reads are answered with 4 bytes per address, so a request may carry at most
// 60 addresses to keep the reply inside one frame.
const MAX_READ = 60;
const MAX_WRITE = 60;

function encodeRead(addrs) {
  if (addrs.length > MAX_READ) throw new Error('too many addresses in one read');
  const p = Buffer.alloc(addrs.length * 2);
  addrs.forEach((a, i) => p.writeUInt16BE(a, i * 2));
  return encode(FN.READ, p);
}

function encodeWrite(pairs) {
  if (pairs.length > MAX_WRITE) throw new Error('too many parameters in one write');
  const p = Buffer.alloc(pairs.length * 4);
  pairs.forEach(([a, v], i) => {
    p.writeUInt16BE(a, i * 4);
    p.writeUInt16BE(v & 0xffff, i * 4 + 2);
  });
  return encode(FN.WRITE, p);
}

function decodePairs(payload) {
  const out = [];
  for (let i = 0; i + 3 < payload.length; i += 4) out.push([payload.readUInt16BE(i), payload.readUInt16BE(i + 2)]);
  return out;
}

function encodeIndexed(fn, index, text) {
  const t = text === undefined ? Buffer.alloc(0) : Buffer.from(text, 'utf8');
  return encode(fn, Buffer.concat([Buffer.from([index]), t]));
}

function decodeIndexed(payload) {
  let end = payload.length;
  const zero = payload.indexOf(0, 1);
  if (zero !== -1) end = zero;
  return { index: payload[0], text: payload.subarray(1, end).toString('utf8') };
}

module.exports = {
  FN, MAX_READ, MAX_WRITE, crc16, encode, decode,
  encodeRead, encodeWrite, decodePairs, encodeIndexed, decodeIndexed,
};
