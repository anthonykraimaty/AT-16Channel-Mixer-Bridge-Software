# Mixer bridge for the SY-X16

Context for Claude. The user's guide is `README.md`; the mixer's control
protocol is in `docs/PROTOCOL.md`. Read the protocol notes before touching
`server/` or `public/js/model.js`.

## What this is

The owner has an SY-X16 digital mixer (default address `192.168.0.144`) and
disliked its built-in web interface, a 5 MB canvas/WASM page. This project is:

- a **bridge** (Node.js, no build step) that holds one connection to the mixer
  and shares it with every screen,
- a **new interface** (plain JS modules, no framework) served by the bridge on
  port 8600,
- a **Windows window** (`MixerBridge.exe`) that runs the bridge without a
  console and sits in the tray,
- an **Android app** (`MixerBridge.apk`) with the same bridge and interface
  inside, on nodejs-mobile.

The folder is a git repository, pushed to
https://github.com/anthonykraimaty/AT-16Channel-Mixer-Bridge-Software (`main`).
`.gitignore` keeps out the signing key, builds, `data/` and `captures/`.

## The mixer is live equipment

- Writing to the mixer changes what people hear. **In a new session, ask
  before testing on it.** Within a session the owner has so far answered
  "test freely".
- Before anything that restarts or stops the bridge, check for sound:
  `node tools/meters-now.js` (about -75 dB means silence).
- Note values before a test and put them back after it. Read through the
  bridge: `node tools/bridge-read.js 127.0.0.1:8600 72 130 188 1956`.
- The owner uses the mixer and the window while tests run. Values can change
  under a test, and dialogs of the window may already be open.
- Do not apply `captures/baseline-params.json`: it predates the owner's own
  settings. Take a fresh snapshot with `node tools/mixer-cli.js dump`.
- Do not log into the mixer's telnet or FTP (ports 23, 21) without the
  owner's go-ahead.
- The mixer stores any value without checking it. Limits live in
  `sanitize` in `public/js/model.js`; a new parameter needs its limits there.

## How the mixer behaves

- Control is a WebSocket on port 8088, binary frames
  `0x80 | len | fn | payload | crc16` (Modbus CRC, high byte first).
  2607 parameters of 16 bits. Use the `ws` library with
  `perMessageDeflate: false`; Node's own WebSocket fails the handshake.
- **Three connections at most.** A fourth is accepted but never answered.
  The PC bridge and the phone's bridge each take one.
- **Faders are not motorised.** When the last client leaves, the mixer fades
  inputs and MAIN to the physical fader positions over about 2.3 seconds.
  While any client is connected the physical faders are ignored (seen once).
  The bridge keeps fader levels (`data/levels.json`) and writes them back
  when it reconnects.
- SOLO on this mixer is pre-fader listen. There is no separate PFL.
- Meters: signed dB bytes, pairs swapped (`meterIndex = n ^ 1`). Strips show
  the pre-fader meter (52 + block); the input meter reads about 6 dB lower.

## Layout

| path | what |
| --- | --- |
| `server/index.js` | entry: HTTP, WebSocket `/ws`, `/status.json`, automatic search for the mixer |
| `server/mixer.js` | the mixer connection, mirror of all parameters, held levels, reconnect |
| `server/protocol.js` | frames and CRC |
| `server/scan.js` | search for the mixer on the local networks (also a CLI) |
| `server/rta.js` | spectrum of a sound card of the PC, recorded by `AudioTap.exe` (`gui/AudioTap.cs`) |
| `server/classic.js` | the original interface through the shared connection (`/classic/`) |
| `server/store.js`, `memory.js`, `configs.js` | settings, held levels, saved configurations |
| `public/js/model.js` | shared model: blocks, offsets, strips, ranges, `sanitize` |
| `public/js/net.js` | the browser's link to the bridge, state, reconnect |
| `public/js/app.js` | main screen: mixes, views, menus, address dialog |
| `public/js/strips.js` | strips, faders, meters |
| `public/js/channel.js` | the settings page of one channel (EQ, dynamics, sends, effects) |
| `public/js/keys.js` | keyboard shortcuts |
| `public/js/ui.js` | `h()`, sheets, dialogs, menus, sliders |
| `gui/MixerBridge.cs` | the Windows window, one file; `gui/build.bat` builds it |
| `android/` | the app: JNI glue, foreground service, WebView |
| `tools/` | utilities from the study of the mixer and for testing |
| `data/` | settings, levels, configurations (created in use) |
| `captures/` | recordings and snapshots from the study |

## Running and building

- **PC:** `MixerBridge.exe` in the project root starts `node server\index.js`
  hidden. `start.bat` does the same in a console. Settings: `config.json`
  (`mixerHost`, `port`, `resumeHours`).
- **Files in `public/`** are served uncached: reload the page, no restart.
- **Files in `server/`** need the bridge restarted: Restart in the window
  (it asks first), or `pwsh tools/gui-click.ps1 -Text "Restart"` twice, the
  second press answering the question.
- **The window:** `gui\build.bat`, run from PowerShell as
  `cmd /c ".\build.bat"` inside `gui/`. It uses the C# 5 compiler that is part
  of Windows, so no string interpolation, `?.`, `nameof` or `out var`. The exe
  must not be running while it is built: Stop, end the program, build, start
  it with `Start-Process` (background tasks of a session got killed for low
  memory).
- **The app:** in `android/`, with the Gradle 8.14 found under
  `~/.gradle/wrapper/dists` (there is no wrapper in the project):
  `gradle assembleRelease --offline`, then copy
  `app/build/outputs/apk/release/app-release.apk` to `MixerBridge.apk`.
  Package `app.mixerbridge`, signed with `android/mixer-bridge.jks`.
  The app carries `server/`, `public/`, `package.json` and `node_modules/ws`,
  so rebuild it after changes to those.
- **adb** is at `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`, not on
  the PATH. In Git Bash set `MSYS_NO_PATHCONV=1` first. The owner's phone is
  a Pixel 7 Pro; its bridge answers at `http://<phone>:8600/`.

## Testing without the owner's screen

- **The window:** `MixerBridge.exe --snapshot file.png` makes the running
  window save a picture of itself, or of the dialog in front. Do not take
  screenshots of the desktop.
- **The phone:** do not open the notification shade (screenshots would show
  personal notifications). Use the emulator (AVD `MixerTest`) for that.
- **The interface:** Playwright against `http://127.0.0.1:8600/`. Its browser
  runs animation frames about once a second: wait a second or more after
  anything that redraws before reading the screen. `await import('/js/net.js')`
  in the page gives the live state (`net.get(addr)`, `net.set(pairs)`).
- **Server changes:** try them on a trial bridge first, with
  `MIXER_DATA=<temp folder> PORT=8699 node server/index.js`. It is one more
  client of the mixer.
- **Tools that talk to the mixer directly** fail silently as the fourth
  connection. Read through the bridge instead.

## Pitfalls met

- Bash heredocs lose backslashes (regular expressions, Windows paths). For
  such edits use the Edit tool.
- `/sdcard/...` paths get rewritten by Git Bash: `MSYS_NO_PATHCONV=1`.
- A function named like an existing one silently replaced it once
  (`loadConfig` in `server/index.js`) and crashed the bridge at start. After
  server changes run `node --check` and start a trial bridge.
- FX sends are offsets +21/+22 of an input block; +15/+16 are AUX 7/8.
- Effect choice is written to addresses 2257/2258, not into the FX block.
- The search for the mixer must stay on local networks: no mobile network of
  the phone (`rmnet`), no VPN, no public addresses. `server/scan.js` sees to it.

## How the owner works

- Short messages, often with typing slips; one feature after the other, each
  tried at once on the real mixer. Questions such as "does it ...?" usually
  mean "make it do that".
- Prefers the phone in landscape.
- Wants things finished and tested, with a plain account of what was tested
  and what was not.

## Writing in this project

- Comments and texts on screen are plain sentences: what it does and why, no
  jargon where a common word will do.
- Match the code around it: small functions, no framework, no build step for
  the web files.
- Keep `README.md` current with every feature the owner can see, and
  `docs/PROTOCOL.md` with everything learned about the mixer.

## Open points

- Physical faders ignored while a client is connected: seen in one test. A
  "use physical faders" switch was offered, not answered.
- The 6 dB offset of the input meter was measured on PC/MP3 only.
- FX return "EQ on" (offset 14) is inferred from the bus block.
- Effect limits were measured on one effect per family.
- Scenes and the media player exist only in `/classic/`.
- The app does not start by itself after the phone restarts.
- Not tested on the phone: file picker and download of configurations,
  `/classic/`, the Scan button on the phone's own screen, keyboard shortcuts
  with a real keyboard.
- `Ctrl` + `1` to `6` (AUX, swapped with `Shift` for FX on 2026-10-04) are
  the browser's keys for tabs too, and `Ctrl` + `A`/`I`/`O` (choose several
  strips) are select-all, page info and open-file; the page takes them over,
  unchecked in the owner's own browser.
- Offered, not answered: renaming SOLO to PFL or adding AFL; removing the
  emulator image and the `MixerTest` AVD.
- RTA over the mixer's USB sound card: tested only with the PC's own
  microphone input and made-up frames. What the mixer sends over USB
  (MAIN?) and its name in Windows are unknown until it is plugged in.
- The phone runs the build of 2026-09-29 11:41, with the mixer search and
  the keyboard shortcuts.
