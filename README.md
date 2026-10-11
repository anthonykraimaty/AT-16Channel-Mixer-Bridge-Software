# Mixer bridge for the SY-X16

A small program that runs on your computer, talks to the mixer, and serves a
better interface to any browser on the network: computer, tablet or phone.

```
phone / tablet / PC  <-->  this bridge (your computer)  <-->  mixer 192.168.0.144
```

## Run it

Double-click `MixerBridge.exe`. It starts the bridge without a console window
and shows:

- whether the mixer is found and in sync, and how many screens are connected
- the addresses to open, with buttons to open the interface or copy the
  address for a phone
- a QR code of the phone address: point the phone's camera at it to open the
  mixer. **Enlarge** (or a click on the code) shows it big, for across the room
- **Restart** and **Stop**, and **Change** for the mixer's address. In there,
  **Scan** searches the networks of this computer for the mixer and lists what
  it finds (`node server/scan.js` does the same in a console)
- **Start with Windows, in the tray**
- what the bridge reports, under Activity

Closing the window leaves the bridge running: the program stays by the clock,
with a green, amber or red dot for the state of the mixer connection. Click the
icon for the window, right-click it to quit. If the bridge ever stops by
itself, it is started again.

Stopping or restarting the bridge while the mixer is connected asks first,
because the mixer goes back to its physical faders when nothing is connected.

`MixerBridge.exe` must stay in this folder, next to `server`. To rebuild it
after changing `gui/MixerBridge.cs`, run `gui\build.bat` (it uses the C#
compiler that is part of Windows).

Without the window, in a console: double-click `start.bat`, or:

```
npm install
npm start
```

Either way the addresses to open are:

- on this computer: `http://localhost:8600/`
- on phones and tablets: `http://<this computer's address>:8600/`

If Windows asks whether Node.js may accept network connections, allow it on
private networks; phones cannot reach the bridge otherwise.

Settings are in `config.json`:

| key | meaning |
| --- | --- |
| `mixerHost` | address of the mixer |
| `port` | port the bridge listens on |
| `resumeHours` | fader levels are put back after a connection drop if the mixer was last in reach less than this many hours ago (default 12, 0 = never) |

## Android app

`MixerBridge.apk` is the bridge and the interface in one app, for Android
phones and tablets and for Chromebooks that run Android apps. It carries the
same bridge files as the computer version, on a Node runtime of its own.

- Install the APK and open **Mixer**. The device must be on the mixer's network.
- If the mixer is at another address, the app looks for it by itself (see
  Finding the mixer). Until it is found the app says it cannot reach it and
  offers **Change mixer address**, with **Scan**. It is also in the menu, top
  right.
- The app keeps running when it is out of sight or the screen is off. A
  notification that stays shows it, with the address other devices can open
  in a browser. **Stop** in that notification ends it.
- Sideways swipes scroll the channels, also when they start on a fader.
- Colours, views and saved configurations are kept per bridge. To take them
  from the computer to the app, use Load, Download file on one and Load, Add
  from file on the other.
- Run one bridge at a time where you can. Each one uses one of the mixer's
  three connections, and each holds fader levels of its own.

To build it again after changes: `gradle assembleRelease` in `android/`
(Android SDK with NDK 28 and CMake 3.22). The Node runtime comes from
nodejs-mobile 18.20.4 and is expected in `android/third_party/nodejs-mobile`.

## Finding the mixer

The bridge can look for the mixer itself, on the computer and in the app alike.

- **By itself.** When the mixer has not answered for 12 seconds, the bridge
  searches its network. If it finds exactly one mixer at another address, it
  moves there, remembers the address and tells every screen. With several
  mixers around it changes nothing: choose one under Mixer address. It looks
  again after 1, 2 and then every 5 minutes for as long as the mixer is away.
- **On request.** Menu, Mixer address, Change, **Scan** lists the mixers found;
  tap one and Connect. The switch below it turns the automatic search off.
- The search tries the mixer's control port (8088) on every address of the
  local network, and asks whatever answers for its model. It stays on home and
  venue networks: never a phone's mobile network, never the internet.
- A mixer whose three connections are all taken cannot answer; it is listed in
  amber as not answering.
- A mixer on another address range than the bridge is not found: type its
  address.

## Keyboard

On the main screen, choose a strip with the keyboard and act on it. The chosen
strip has a white frame; clicking a strip with the mouse chooses it too.

| key | does |
| --- | --- |
| `1` to `9` | choose channel 1 to 9 |
| `1`, then quickly `0` to `4` | choose channel 10, 11, 12 or 13/14 (within 0.6 seconds) |
| `M` | choose MAIN |
| `Ctrl` + `1` to `6` | choose AUX 1 to 6; pressed again, open the faders of that AUX |
| `Shift` + `1` or `2` | choose FX 1 or 2; pressed again, open the sends to that effect |
| `Space` | mute or unmute what is chosen |
| `S` | solo what is chosen |
| `Shift` + `S` | solo what is chosen and take solo off everything else |
| `.` (full stop, or on the number pad) | fader of what is chosen to 0 dB |
| `0` on the number pad, or `-` | fader of what is chosen all the way down |
| `↑` `↓` | fader of what is chosen up and down by 0.5 dB; keep pressed to go on |
| `Shift` + `↑` `↓` | the same in fine steps of 0.1 dB |
| `Page Up` `Page Down` | the same in steps of 3 dB |
| `R` | name and colour of what is chosen |
| `P` | on the faders of an AUX: all sends pre-fader; again: all post-fader |
| `Ctrl` + `A` | choose every strip on screen |
| `Ctrl` + `I` | choose the input channels on screen |
| `Ctrl` + `O` | choose the outputs on screen (AUX, MAIN) |
| `Ctrl` + click | add a strip to what is chosen, or take it away |
| `Shift` + `Space` | mute all channels and effect returns; again: back to how it was |
| `Esc` | nothing chosen |
| `?` | the list of shortcuts |

- With several strips chosen, `Space`, `S`, the arrows, `Page Up`/`Down` and
  `.`, `0`/`-` act on all of them: each fader moves by the same step from where
  it stands, and `Space` mutes them all if any still sounds, otherwise
  unmutes them all. Choosing one strip, or `Esc`, ends it. Only strips on
  screen count.
- Inside the faders of an AUX, mute and fader act on the send of the chosen
  channel to that AUX. `M` leads back to the main mix.
- Mute all leaves the outputs alone. What was muted before is kept by the
  bridge, so any screen can bring it back, with the keys or with the red
  **All muted** button at the top.
- On the page of a channel the keys act on that channel: `Space`, `S`,
  `Shift` + `S`, the arrows, `.` and `0`/`-` work on its fader, and the keys
  that choose a strip (`1`..`9`, `M`, `Ctrl` + number, `Shift` + number) turn
  to that strip's page. A control of the page that has the focus keeps the
  arrows; `Esc` closes the page.
- Keys do nothing while you type, or while a menu or a dialog is open. They
  are off in personal monitor links, except for the channels of that mix.
- Digits are taken from the place of the key, so they work on keyboards where
  digits need Shift (AZERTY) as well.

## Spectrum (RTA)

The EQ graph of every channel page can show the spectrum of the sound behind
the EQ curve. The mixer sends no sound over the network, so the sound comes
from its USB sound card: connect the mixer's USB-B port (on the back, marked
USB/PC) to the PC running the bridge.

1. In the menu (the name at the top left), under **Spectrum (RTA)**, choose
   the mixer's sound card. Windows shows names of 31 letters at most.
2. Open a channel. The spectrum appears behind the EQ curve: 0 dB of the card
   at the top, -90 dB at the bottom. The **RTA** switch on the EQ card hides
   it on this screen.

The USB card carries a stereo pair, by the manual the same as the recording,
most likely MAIN. So the spectrum is of what goes there, not of the open
channel alone: mute or solo-out the other channels to look at one.

- Only the PC can record the card. A phone sees the spectrum when it opens
  the PC's bridge (`http://<pc>:8600/`); the phone app's own bridge has none.
- Recording runs only while a channel page with RTA on is open, and stops
  five seconds after the last one closes.
- `AudioTap.exe` in the project folder does the recording; `guiuild.bat`
  builds it along with the window.

## Connection drops

The mixer's faders are not motorised. When its last network client leaves, the
mixer fades every channel and the main level to where the faders physically
stand, over about two seconds.

- **Keep the bridge running.** While it is connected the mixer never falls
  back, no matter how many phones or browser tabs come and go.
- If the bridge itself loses the mixer (network fault, mixer restarted, bridge
  restarted), it reconnects on its own within a fraction of a second and puts
  the fader levels back. They are also saved in `data/levels.json`, so this
  works across a restart of the bridge or the computer.
- During the mixer's two-second fade the level can flutter; it is steady again
  as soon as the fade has run out.
- Browsers reconnect by themselves, also after a phone wakes up. No page
  refresh is needed. A message tells you when levels were put back.
- The menu (top right) has a switch to turn this off, for when you want the
  physical faders to win.

## What it adds

- **Names for everything**, AUX, FX and MAIN included. Names are stored in the
  mixer, so they also appear on the mixer's screen and in the original app.
- **Colours** per strip.
- **Views**: choose which channels and AUX strips to show, in which order, and
  switch between them. Views are shared by all devices.
- **Mix on faders**: pick an AUX or FX at the top and the faders become each
  instrument's level in that mix, with PRE/POST and MUTE per send. MUTE
  silences that instrument in that mix only and brings its level back when
  switched off. `Sources` hides the
  instruments a mix never needs: hiding one also turns its send to that mix
  off, and showing it again brings the level back. On an AUX, `All pre` and
  `All post` (or the `P` key) set every send into it at once; neither is lit
  when the sends are mixed.
- **Personal monitor links** (menu, top right): a link that opens one mix only,
  for a musician's phone.
- **Channel page** (tap a name): every setting of that channel on one screen.
  Name and colour, gain, +48V, phase, pan, high-pass and low-pass filters, EQ
  with a draggable curve, gate, compressor and all sends, with the channel's
  own fader, mute and solo always on the right. Outputs add delay and feedback
  cut. FX1 and FX2 add the choice of effect, from a list of sixteen, with its
  two settings. Drag a value sideways to change it, use − / + for single steps, and
  double-click a value to reset it. The arrows at the top step through channels. On an AUX, FX or MAIN page
  the **Faders** button at the top leads straight to the faders of that mix.
- **Strip menu**: right-click a channel, or hold a finger on it (anywhere but
  the fader). Rename and colour, fader to 0 dB, fader down, mute, all settings.
  Inside an AUX or FX mix it acts on that send instead of the channel fader.
- **Save and Load** (top right): keep the whole state under a name and bring
  it back later. A configuration holds every mixer setting and name, plus the
  colours, views and mix sources. Loading takes two presses because it changes
  the sound at once, and lets you choose what to bring back: mixer settings,
  names, colours and views. Configurations can be downloaded as a file and
  added from a file. They are kept in `data/configs`.
- Changes made on the mixer itself or in the original app show up live.

## The original interface

`http://localhost:8600/classic/` is the mixer's own interface, running through
the bridge's connection. Use it for what the new interface does not cover:
scenes, the media player and system settings. It reconnects
by itself, and what you set in it is held across connection drops as well.

The mixer answers only three connections at a time. Everything that goes
through the bridge, on any number of devices, shares a single one. Opening the
mixer's address directly (`http://192.168.0.144/`) uses one of its own and
does not get the protection against connection drops.

`http://localhost:8600/classic-direct/` is the plain relay, with a mixer
connection of its own per page. It is there in case something in the original
interface misbehaves through the shared connection.

## Files

| path | purpose |
| --- | --- |
| `MixerBridge.exe` | the window that starts the bridge on Windows |
| `AudioTap.exe` | records a sound card for the spectrum (RTA) |
| `gui/` | its source, fonts and build script |
| `server/` | the bridge |
| `public/` | the new interface |
| `data/settings.json` | colours, views and mix sources (created on first use) |
| `data/levels.json` | the fader levels held for connection drops |
| `docs/PROTOCOL.md` | how the mixer's control protocol works |
| `tools/` | utilities used to study the mixer, including `restore.js` |
| `captures/` | recordings and a snapshot of all mixer settings taken before testing |

`node tools/restore.js` compares the mixer with that snapshot;
`node tools/restore.js --apply` writes the snapshot back.
