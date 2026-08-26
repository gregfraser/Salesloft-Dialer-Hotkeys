# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two things that ship together:

1. **A Chrome extension** (Manifest V3, plain JavaScript — no build system, no bundler, no `package.json`) that automates Salesloft cadence dialing. Two actions, `kill-and-log` (end call → set disposition → click "Log & Complete") and `start-call`, triggerable by global hotkeys, an on-page overlay, or a floating panel window.
2. **A local Python transcription service** (FastAPI + Silero VAD + faster-whisper) that turns live call audio into on-screen text. Runs on loopback only; no audio is written to disk or leaves the machine.

Installed via "Load unpacked" from `extension/`; not in the Chrome Web Store.

```
extension/   MV3 extension — load this folder in chrome://extensions
server/      FastAPI transcription service (run from inside this directory)
scripts/     Phase 0 benchmark, WAV replay harness, Windows setup
tests/       pytest (server) + node --test (extension JS)
docs/        architecture, compliance, troubleshooting
```

## Commands

There is no build step or linter. Tests exist and are fast:

```bash
python -m pytest tests/                        # 92 tests: VAD, queue, protocol, session, benchmark
python -m pytest tests/test_vad_endpointing.py # a single file
python -m pytest tests/ -k merges -q            # a single test by name
node --test tests/test_salesloft_detection.js  # DOM detection (21)
node --test tests/test_pcm_worklet.js          # audio downsampling (14)
```

`node --test tests/` does **not** work — the directory is named `tests` and the files use underscores, so neither matches Node's default discovery patterns. Name the file explicitly.

The Python tests need only `numpy pytest pyyaml fastapi httpx`. faster-whisper, torch and Silero are imported lazily inside methods precisely so the whole suite runs without them; keep it that way when adding code. `tests/conftest.py` puts `server/` on the path because the service modules import each other by bare name (they run package-less under uvicorn).

Running the service:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1       # one-time
powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1  # each session
python scripts/replay_wav.py sample.wav                            # exercise it without Chrome
python scripts/benchmark.py --models base.en,small.en sample.wav   # Phase 0 gate
```

## Verifying extension changes

Manual, against the live Salesloft app:

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
2. After editing `background.js`, `manifest.json`, `defaults.js` or `call-detect.js`: reload the extension card.
3. After editing `content.js`: reload the extension **and** refresh the `app.salesloft.com` tab.
4. After editing `offscreen.js` or `pcm-worklet.js`: reload the extension and restart capture (`Ctrl+Shift+8` twice) — the offscreen document is only recreated on the next capture.
5. After editing `panel.*` or `settings.*`: close and reopen that window/popup.

## Architecture

Four execution contexts in Chrome plus one Python process. Understanding any feature means tracing it across several. `docs/architecture.md` has the full diagram and rationale.

- **`background.js`** (service worker) — the relay and the owner of transcription state (`IDLE → STARTING → TRANSCRIBING → FINALIZING`, plus first-class `DEGRADED`). Finds the most-recently-accessed Salesloft tab, forwards dialer actions, and on failure injects the content scripts via `chrome.scripting` and retries once. Owns the panel window (id in `chrome.storage.session`, so it survives worker sleep), the offscreen document lifecycle, and capture arming.
- **`content.js`** — runs only on `https://app.salesloft.com/*`; performs the DOM automation, renders the optional overlay, handles in-page F8/F9. Guards double-injection with `window.__slHotkeysLoaded`.
- **`call-detect.js`** — call-state detection, **observe only**. Takes its DOM access as injected functions (`elements`, `isVisible`) so it is testable without a DOM.
- **`offscreen.js`** + **`pcm-worklet.js`** — hidden document holding the `AudioContext`, the mandatory passthrough, the downsampler and the WebSocket. MV3 service workers terminate after ~30s and cannot hold `MediaStream`s, which is why this exists.
- **`panel.*`** / **`settings.*`** — thin UIs.
- **`server/`** — `main.py` (FastAPI + session), `vad.py` (Silero + `Endpointer`), `transcription.py` (`UtteranceQueue`, filters, metrics), `websocket.py` (protocol), `audio.py`, `config.py`.

### Settings

`chrome.storage.sync` holds dialer settings (`floatingPanel`, `pageOverlay`, `disposition`) and transcription settings (`transcription`, `autoStartTranscription`, `saveTranscripts`, `outputDeviceId`, `serverUrl`, `healthUrl`).

**`extension/defaults.js` is the single definition** — loaded as a plain script by the content script (via the manifest), the service worker (`importScripts`), and both HTML pages (`<script>` before their own). Add new settings there only; do not reintroduce per-file copies.

Nothing sends messages about settings changes: the background and content script each react to `chrome.storage.onChanged`.

### Message protocol

`{type:'dialer-action', action}` flows toward the content script; `{type:'status', msg, kind}` flows back. The action names double as the manifest command names and the handler dispatch keys — keep all three aligned when adding an action.

Transcript and status messages from the offscreen document reach the panel **directly** via `chrome.runtime.sendMessage`. The service worker observes them for its state machine and deliberately does not re-broadcast; re-broadcasting would render every transcript line twice.

### DOM automation (the fragile part)

`content.js` drives Salesloft's React UI with no API access:

- Buttons found by exact (case-insensitive, whitespace-collapsed) visible text — "End Call", "Log & Complete", "Call" — scoped to `[data-testid="popout-logger-container"]` when logging.
- The disposition dropdown is a Downshift combobox, located via `[id$="toggle-button"]` / `[aria-haspopup="listbox"]` near the text "Disposition"; the option is matched against the `disposition` setting exactly.
- `realClick()` dispatches the full pointerdown → mousedown → pointerup → mouseup → click sequence because React controls ignore a bare `.click()`.
- `waitFor()` polls every 100 ms with an 8 s timeout.

Detection in `call-detect.js` uses a tier hierarchy instead: ARIA label → visible text → `data-testid` tokens. Generated styled-components classes (`.sc-imkklV`) are never matched — they change on every Salesloft deploy.

When Salesloft ships UI changes, these are what break.

## Invariants to preserve

**Dialer**

- `killAndLog` sets the disposition **before** clicking "Log & Complete". Any failed step throws, surfaces "Stopped: … Finish manually.", and leaves the call unlogged — never log with a wrong or missing disposition.
- A `busy` flag serializes flows; hotkeys and clicks are ignored while one runs.
- In-page hotkeys are suppressed while typing (`isTyping()`).

**Transcription**

- **The passthrough is load-bearing.** Tab capture removes audio from normal playback; `offscreen.js` must reconnect the source to `AudioContext.destination`. If the graph cannot be built or the context will not leave `suspended`, capture is torn down entirely — no transcription always beats a broken call. This cannot be caught by any test that is not a real call.
- **The transcription path never clicks Salesloft controls.** Detection observes; `content.js` acts. Keep them separate so a detection bug can never mis-log a call.
- **Never fail loudly mid-call.** No modal, alert, focus steal, or anything that pulls attention. Failures surface as a quiet status line, and `DEGRADED` is a normal state.
- **No audio to disk, ever.** Nothing in `server/` opens a file for audio; `config.py` refuses to start if `storage.save_audio` is true. Buffers are freed the moment inference returns.
- **VAD gating is not an optimisation.** Whisper pads every input to 30s, so a 2s slice costs about what a 25s one does. Silence must produce zero invocations.
- **Backpressure coalesces, it does not drop.** Merging queued utterances costs the same as one inference and keeps all the speech; dropping is the last resort when a merge would exceed the 30s window.
- **Capture arming is a Chrome constraint, not a bug.** A tab capture stream requires the extension to have been invoked on that tab, and the invocation authorises whichever tab was active. So the from-any-tab hotkeys cannot *start* capture — only `Ctrl+Shift+8` (or a command fired) with Salesloft in front can. It persists across tab switches afterward.
- Scope stays `https://app.salesloft.com/*` plus `http://127.0.0.1:8765/*`; the server binds to `127.0.0.1` and validates the WebSocket origin.

## Compliance gate

IT has approved the software. **Legal/compliance sign-off for capturing live calls has not been given.** `docs/compliance.md` holds the sign-off record and must be updated when that changes. Do not add anything that encourages live capture before that gate clears, and if disclosure turns out to be required, design it into the flow rather than bolting it on.
