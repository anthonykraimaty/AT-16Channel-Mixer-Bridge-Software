# SY-X16 control protocol

Worked out by recording the mixer's own web interface (a WebAssembly app served
from port 80) while operating it, and by writing single parameters and watching
which control moved. Everything here was observed on one SY-X16; items marked
*unverified* are inferences.

## Transport

- WebSocket on port **8088**, any path, binary frames. No compression: a client
  that offers `permessage-deflate` is refused.
- The mixer closes a connection that sends nothing for about 5 seconds. Any
  request counts as activity.
- **Three clients are served at a time.** Further connections are accepted but
  never answered. The bridge uses one connection for all of its browsers; each
  open copy of the original interface uses one more.
- Other ports: 80 (interface), 8080 (device finder page), 21, 23, 8087, 9000
  (not examined).

## Frame

```
0x80 | len | fn | payload ... | crc_hi | crc_lo
```

- `len` = number of bytes after it (fn + payload + 2).
- CRC is CRC-16/MODBUS (poly 0xA001 reflected, init 0xFFFF) over every byte
  before it, stored **high byte first**.

## Functions

| fn | direction | payload | meaning |
| --- | --- | --- | --- |
| `00` | request/reply | `00` → `00 e0 02 22 01 "SY-X16" 00` | device info |
| `03` | request/reply | (addr16 value16)+, echoed | write parameters |
| `04` | request/reply | index → index + text | scene name, index 1..16 |
| `06` | request/reply | addr16+ → (addr16 value16)+ | read parameters (60 per frame at most) |
| `25` | mixer → client | (addr16 value16)+ | a parameter changed elsewhere; the client echoes the frame back |
| `2e` | request/reply | index → index + text | read strip name (empty = default) |
| `2f` | request/reply | index + text, echoed | write strip name; 31 bytes are kept |
| `39` | request/reply | `KEY=` → `KEY=value\n` | text settings (`DEVNAME`, network, lock) |
| `71` | mixer → client | 13 bytes | periodic status, not decoded |

All multi-byte values are big-endian. The mixer stores any value it is sent
without range checks, so limits must be enforced by the client. The ranges
below are the ones the original interface stops at.

## Parameter table

2607 parameters, addresses 0..2606.

| range | content |
| --- | --- |
| 2..48 | meters, two per address (high byte, low byte) |
| 64..1571 | 26 input blocks of 58 |
| 1572..2051 | 10 bus blocks of 48 |
| 2088..2177 | 2 FX return blocks of 45 |
| 2269..2283 | device status (address of the client, uptime, ...) |
| 2284.. | effect preset tables, not decoded |

### Input block (base = 64 + 58 × n)

| offset | parameter | encoding and range |
| --- | --- | --- |
| 1 | +48V | 0/1 |
| 2 | gate on | 0/1 |
| 3 | gate threshold | dB below zero, 0..120 |
| 4 | gain | dB, 0..45 |
| 5 | phase | 1 = normal, 0 = inverted |
| 6 | on | 1 = on, 0 = muted |
| 7 | pan | 0..200, 100 = centre |
| 8 | fader | level |
| 9..14 | sends to AUX1..6 | level, bit 15 = pre-fader |
| 15, 16 | sends to AUX7, AUX8 | buses the X16 does not have |
| 17, 18 | level to MAIN L, MAIN R | level |
| 19, 20 | solo left, solo right | `0x84b0` on, `0x44b0` off |
| 21, 22 | sends to FX1, FX2 | level |
| 25 | compressor on | 0/1 |
| 26 | ratio | ratio × 10, 10..200 |
| 27 | attack | ms × 10, from 30; 6642 was reached, the limit is higher |
| 28 | release | ms × 10, 100..50000 |
| 29 | compressor threshold | signed dB × 10, −800..+100 |
| 32 | EQ on | 1 = on, 0 = bypassed |
| 34, 36 | filter kinds | 20 = high-pass, 21 = low-pass; left untouched |
| 35 | high-pass frequency | frequency; 19.6 Hz = off |
| 37 | low-pass frequency | frequency; 20600 = off |
| 38..53 | EQ bands 1..4: kind, frequency, gain, Q | kind 7 = bell |
| 0, 23, 24, 30, 31, 33, 54..57 | unknown | no visible effect in the original interface |

Blocks in use on the X16: 0..11 = CH1..12, 12..15 = CH13/14 (left 12 and 14,
right 13 and 15), 24/25 = PC/MP3.

### Bus block (base = 1572 + 48 × n)

| offset | parameter | encoding and range |
| --- | --- | --- |
| 0 | fader | level |
| 1 | phase | 1 = normal, 0 = inverted |
| 2 | on | 1 = on, 0 = muted |
| 3 | feedback canceller | 0 = off, 1..3 |
| 5 | delay | ms × 10, 0..400 |
| 6 | compressor on | 0/1 |
| 7, 8, 9 | ratio, attack, release | as for inputs |
| 10 | compressor threshold | as for inputs |
| 12, 13 | solo left, solo right | 1200 on, 0 off |
| 14 | EQ on | 1 = on, 0 = bypassed |
| 17 / 19 | high-pass / low-pass frequency | |
| 20..47 | EQ bands 1..7 | |

Buses: 0..3 = AUX1..4, 4/5 = AUX5/6, 8/9 = MAIN L/R.

### FX return block (base = 2088 + 45 × n)

| offset | parameter |
| --- | --- |
| 0 | fader |
| 1 | on |
| 2..7 | sends to AUX1..6 |
| 10, 11 | level to MAIN L, MAIN R |
| 12, 13 | solo left, solo right |
| 14 | EQ on (*unverified*, by analogy with the bus block) |
| 17 / 19 | high-pass / low-pass frequency |
| 20..35 | EQ bands 1..4 |
| 40 | effect number, 1..16; the second unit stores 17..32 |
| 41, 42 | the effect's two settings |
| 43, 44 | unused |

### Effects

| number | effect | setting A | setting B |
| --- | --- | --- | --- |
| 1..5 | Reverb Hall, Room, Plate, Vocal 1, Vocal 2 | pre-delay, ms, 0..30 | duration, s × 10, 0..100 |
| 6..10 | Vocal Echo 1, Vocal Echo 2, Delay 1, Delay 2, Mod. Delay | delay, shown as value × 5 ms, 0..68 | repeat, %, 0..100 |
| 11 | Reverb Gate | shown as s × 10, 0..100 | shown as %, 0..100 |
| 12 | Pitch Change | slope, 0..63 | depth, %, 0..100 |
| 13..16 | Chorus, Phaser, Flange, Tremolo | rate, shown as Hz, 0..42 | depth, %, 0..100 |

The mixer keeps the settings of every effect per unit in a table, five
parameters per effect (number, setting A, setting B, two unused): unit 1 at
2284..2363, unit 2 at 2445..2524. The tables that follow each (2364.., 2525..)
hold sixteen more entries of the same shape whose use is not known.

Limits were measured on one effect of each family (1, 6, 11, 12, 13) and are
assumed to hold for the others of that family.

An effect is chosen by writing its number, 1..16, to the unit's select
address: **2257** for unit 1, **2258** for unit 2. The mixer then sets offset
40 and loads the two settings it remembers for that effect into offsets 41
and 42. It does not announce this to the client that wrote, so those three
addresses have to be read back. The original interface writes nothing else:
not offset 40, not the table.

Changing a setting is a plain write to offset 41 or 42.

### Encodings

- **Level**: `(dB + 120) × 10`, 0 = −∞, 1200 = 0 dB, 1300 = +10 dB.
- **Frequency**: Hz; with bit 15 set the remaining bits are tenths of Hz
  (used below 100 Hz).
- **Signed values**: sign and magnitude. Bit 15 set means negative, the other
  bits are the magnitude (−80.0 dB = `0x8320`).
- **EQ gain**: `500 + dB × 10`, range 380..620 (±12 dB).
- **EQ Q**: `Q × 100`, range 60..2808.
- **Stereo strips** write the same value to every block of the strip. For solo,
  left blocks feed solo-left only and right blocks solo-right only.

### Physical faders

The faders on the mixer are not motorised. The levels that have one are the
input faders (blocks 0..15, 24, 25) and MAIN (buses 8, 9).

- While at least one client is connected, a written level stays. Moving a
  physical fader is expected to be announced with function `25`, like any
  other change made on the mixer (*unverified*: nobody moved a fader while
  this was studied).
- When the **last** client disconnects, the mixer fades each of these levels
  to the position of its physical fader: a step about every 110 ms for roughly
  2.3 seconds, the last step jumping to the target. Nothing else is changed
  (mutes, gain, EQ, sends, AUX and FX levels stay).
- A client that connects during the fade receives every step as a `25` frame.
  Levels written during the fade are pulled back at the next step; levels
  written after it stay.

The bridge therefore keeps its connection open at all times, remembers these
levels, writes them back after every fade step it is told about, and checks
them once more when no step has arrived for 600 ms.

### Names

Slots 0..25 follow the input blocks, 26..35 the buses, 36/37 the FX returns.
A stereo strip shows the name of its first slot. Name changes are not
announced to other clients; re-read them to notice changes.

### Meters

Addresses 2..48 hold two meters each: the even-numbered meter in the low
byte, the odd-numbered one in the high byte. A meter byte is the level in dB
as a signed number (`0xff` = -1 dB, `0xec` = -20 dB, `0x05` = +5 dB); the
idle value `0xb5` is -75 dB. 0 dB is the nominal level, not the limit.

| meter | what it shows |
| --- | --- |
| 0..25 | inputs at the input, by block number; the CH13/14 strip shows 14 and 15 |
| 26..51 | the same inputs after the EQ |
| 52..77 | the same inputs after the compressor, before the fader |
| 78/79, 80/81 | FX1, FX2 returns, left and right |
| 82..89 | AUX1..AUX8 |
| 90, 91 | MAIN left, right |

The input meter reads about 6 dB lower than the two later points for the
same signal with flat EQ (measured on PC/MP3: 5.9 dB). The later points and
the output meters share one scale: a pre-fader send at −10 dB shows on the
output about 10 dB below the pre-fader meter, and the compressor threshold
acts in the units of that scale. Where the 6 dB come from is not known, and
it was measured on PC/MP3 only. The original interface shows the input
meter; the bridge's interface shows the pre-fader one, so that a channel and
the outputs it feeds agree.

The output assignments were confirmed on the real mixer by sending one input
to one output at a time (`tools/meter-probe.js`); the three input points by
changing EQ and compressor and watching each (`tools/meter-banks.js`).

The mixer's own meter has twelve steps of equal height that light at -30,
-25, -20, -15, -10, -7, -4, -2, 0, +5, +10 and +14 dB: nine green, two
yellow, one red. It falls back at roughly 14 dB per second.

Established by feeding the original interface known values from a stand-in
(`tools/fake-mixer.js`, `tools/meter-law.js`, `tools/meter-map.js`) and checked
against the real mixer with music playing.

## Sound over USB

From the printed manual (photos in `Mixer Manual Book Scan/`): the USB-B
port on the back is a USB sound card, "two-way stereo audio transmission with
PC", 48 kHz / 24 bit. The spec sheet lists it as "USB stereo soundcard" next
to "stereo channel record", so the pair sent to the PC is most likely MAIN.
Not yet confirmed on the mixer: what it sends, whether a menu chooses it, and
the name it has in Windows. The touch screen also has a "Local Spectrum"
page; no spectrum data has been seen on the network connection.
