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
docs/        architecture, troubleshooting
```

## Commands

There is no build step or linter. Tests exist and are fast:

```bash
python -m pytest tests/                        # 92 tests: VAD, queue, protocol, session, benchmark
python -m pytest tests/test_vad_endpointing.py # a single file
python -m pytest tests/ -k merges -q            # a single test by name
node --test tests/test_salesloft_detection.js  # DOM detection (21)
node --test tests/test_pcm_worklet.js          # audio downsampling (14)
node --test tests/test_transcript_format.js    # shared transcript formatting (10)
```

`node --test tests/` does **not** work — the directory is named `tests` and the files use underscores, so neither matches Node's default discovery patterns. Name the file explicitly.

The Python tests need only `numpy pytest pyyaml fastapi httpx`. faster-whisper, torch and Silero are imported lazily inside methods precisely so the whole suite runs without them; keep it that way when adding code. `tests/conftest.py` puts `server/` on the path because the service modules import each other by bare name (they run package-less under uvicorn).

Running the service:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1       # one-time
powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1  # each session
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Toggle
python scripts/replay_wav.py sample.wav                            # exercise it without Chrome
python scripts/benchmark.py --models base.en,small.en sample.wav   # Phase 0 gate
```

The three `.cmd` files in the repo root (`Install.cmd`, `Start Server.cmd`,
`Auto-start.cmd`) are double-click wrappers around the first three and nothing
else — the audience is a rep who should never have to type
`-ExecutionPolicy Bypass`. Keep them that way: no logic in the batch files
beyond `pushd`, the call, and reporting the exit code. They are stored with CRLF
and pinned by `.gitattributes` (`*.cmd -text`), because `cmd.exe` mis-parses a
multi-line `if()` block in a file with bare LF endings.

**`install.ps1` checks `$LASTEXITCODE` after every native call, and must keep
doing so.** This is Windows PowerShell 5.1, where `$ErrorActionPreference` only
governs PowerShell's own errors — a `python.exe` or `pip.exe` that exits nonzero
raises nothing, so an unchecked failure falls through and the script still ends
with "Setup complete." in green. (PowerShell 7.3+ has
`$PSNativeCommandUseErrorActionPreference`; 5.1 has no equivalent.) The step
that matters most is the CPU-only torch install: `requirements.txt` lists
`torch>=2.0`, so if that step fails and the script continues, the next one
satisfies torch from ordinary PyPI and silently installs ~2.5GB of CUDA
libraries. A `torch.version.cuda is None` assertion after the install catches
it arriving by any other route.

Invoke pip as `& $venvPython -m pip`, never `Scripts\pip.exe`. That `.exe` is a
generated console-script shim, and pip's self-upgrade on Windows renames its own
package to `~ip` and regenerates the shim last — interrupt it and `pip.exe` is
gone while `python -m pip` still works.

## Verifying extension changes

Manual, against the live Salesloft app:

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
2. After editing `background.js`, `manifest.json`, `defaults.js` or `call-detect.js`: reload the extension card.
3. After editing `content.js` or `alerts.js`: reload the extension **and** refresh the `app.salesloft.com` tab.
4. After editing `offscreen.js` or `pcm-worklet.js`: reload the extension and restart capture (`Ctrl+Shift+8` twice) — the offscreen document is only recreated on the next capture.
5. After editing `panel.*` or `settings.*`: close and reopen that window/popup.

## Architecture

Four execution contexts in Chrome plus one Python process. Understanding any feature means tracing it across several. `docs/architecture.md` has the full diagram and rationale.

- **`background.js`** (service worker) — the relay and the owner of transcription state (`IDLE → STARTING → TRANSCRIBING → FINALIZING`, plus first-class `DEGRADED`). Finds the most-recently-accessed Salesloft tab, forwards dialer actions, and on failure injects the content scripts via `chrome.scripting` and retries once. Owns the panel window (id in `chrome.storage.session`, so it survives worker sleep), the offscreen document lifecycle, and capture arming.
- **`content.js`** — runs only on `https://app.salesloft.com/*`; performs the DOM automation, renders the optional overlay (buttons, contact-alert line, status, and — when transcription is on — the live transcript pane), handles in-page F8/F9. Guards double-injection with `window.__slHotkeysLoaded`.
- **Orphaned content scripts are a normal state.** Reloading or updating the extension leaves the old content scripts running in the page with `chrome.runtime` gone — accessing it throws. Every `chrome.*` send from a content script goes through a guard (`safeSend()` in `content.js`, try/catch in `alerts.js`) so the DOM flows still complete from a stale script, and `buildOverlay()` always **replaces** an existing overlay rather than keeping it, because a leftover one is wired to the dead context. Preserve both patterns in new content-script code.
- **`call-detect.js`** — call-state detection, **observe only**. Takes its DOM access as injected functions (`elements`, `isVisible`) so it is testable without a DOM.
- **`alerts.js`** — reads the Disposition / Sentiment tags already on the contact's page, **read only**. It renders nothing of its own: the colour-coded alert shows in the floating panel (via a `contact-alert` message) and as a subtle line inside the on-page overlay (via the `window.__slOnContactAlert` hook `content.js` registers in their shared isolated world). `content.js` also reads `window.__slContactAlert` for its status line.
- **`offscreen.js`** + **`pcm-worklet.js`** — hidden document holding the `AudioContext`, the mandatory passthrough, the downsampler and the WebSocket. MV3 service workers terminate after ~30s and cannot hold `MediaStream`s, which is why this exists.
- **`panel.*`** / **`settings.*`** — thin UIs.
- **`server/`** — `main.py` (FastAPI + session), `vad.py` (Silero + `Endpointer`), `transcription.py` (`UtteranceQueue`, filters, metrics), `websocket.py` (protocol), `audio.py`, `config.py`.

### Settings

`chrome.storage.sync` holds dialer settings (`floatingPanel`, `pageOverlay`, `disposition`), contact-alert settings (`alertsEnabled`, `alertTags`, `alertStrict`) and transcription settings (`transcription`, `outputDeviceId`, `serverUrl`, `healthUrl`). With `transcription` on, auto-start is unconditional — it is a behaviour, not a setting. `transcription` also decides whether the on-page overlay carries the transcript pane, so toggling it rebuilds the overlay.

**No transcript is ever downloaded automatically.** A cadence is dozens of dials and almost none of them are worth a file, so a save happens only from a click on a ↓ button. Both UIs enforce this; a "save it for them" convenience is the thing not to add back. Chrome independently forbids it on the page side anyway — a web page gets one uninvited download before Chrome starts asking the user's permission for the rest, so an automatic per-call save from `content.js` would put a permission bubble on the Salesloft page partway through a call block.

What *is* automatic is the offer. `stopTranscription()` waits for the server to drain the queue and only then calls `offerTranscriptSave()`, which sends `transcript-unsaved` to both channels; each UI answers by putting a line in its status and highlighting its ↓ button, and ignores it when nothing is unsaved. The flush is the point of the wait: offering on the call-end `call-state` message instead would mean the rep saves a file missing the call's last utterance.

**`extension/defaults.js` is the single definition** — loaded as a plain script by the content script (via the manifest), the service worker (`importScripts`), and both HTML pages (`<script>` before their own). Add new settings there only; do not reintroduce per-file copies. It also holds what the panel and the on-page transcript both need to agree on — the alert palette, and the transcript formatters (`slFormatClock`, `slTranscriptText`, `slTranscriptFilename`) — so a line reads the same in either and a saved file does not depend on which one wrote it. Its `module.exports` is what makes those testable under `node --test`.

Nothing sends messages about settings changes: the background and content script each react to `chrome.storage.onChanged`.

### Message protocol

`{type:'dialer-action', action}` flows toward the content script; `{type:'status', msg, kind}` flows back. The action names double as the manifest command names and the handler dispatch keys — keep all three aligned when adding an action.

Transcript and status messages from the offscreen document reach the panel **directly** via `chrome.runtime.sendMessage`. The service worker observes them for its state machine and deliberately does not re-broadcast on that channel; re-broadcasting would render every transcript line twice in the panel.

Content scripts receive none of those broadcasts, so the on-page transcript is fed by the worker relaying each one on with `chrome.tabs.sendMessage` (`forwardToSalesloft`). That is a separate channel from the broadcast — it cannot double a line the panel already drew — and it is the only reason the worker touches transcript traffic at all. `transcription-paused` is echoed to **both** channels, because pause is one piece of capture state that two UIs display.

### DOM automation (the fragile part)

`content.js` drives Salesloft's React UI with no API access:

- Buttons found by exact (case-insensitive, whitespace-collapsed) visible text — "End Call", "Log & Complete", "Call" — scoped to `[data-testid="popout-logger-container"]` when logging.
- The disposition dropdown is a Downshift combobox, located via `[id$="toggle-button"]` / `[aria-haspopup="listbox"]` near the text "Disposition"; the option is matched against the `disposition` setting exactly.
- `realClick()` dispatches the full pointerdown → mousedown → pointerup → mouseup → click sequence because React controls ignore a bare `.click()`.
- `waitFor()` polls every 100 ms with an 8 s timeout.

Detection in `call-detect.js` uses a tier hierarchy instead: ARIA label → visible text → `data-testid` tokens. Generated styled-components classes (`.sc-imkklV`) are never matched — they change on every Salesloft deploy.

Tag matching in `alerts.js` follows the same rule — the pills it reads are
`<span class="sc-eSdRwT">`, so it anchors on structure, never on that class:

- A candidate must be an element whose **entire** text is the tag. That is what separates the `Interested` pill from a call note reading "Interested but doesn't work with…".
- Candidates resolve past custom elements (any tag name containing `-`) before that check. A highlighter extension wrapping a match would otherwise both split the tag across text nodes and make the enclosing note look like a bare tag.
- Context comes from one of three places, in order: the preceding sibling (Salesloft stacks `<p>Sentiment</p><p>Interested</p>`, and adjacent element text concatenates with no whitespace, so a `\bsentiment\b` match on the parent fails), a table column header by cell index, or simply being inside an activity row (`[class*="activity__"]`) — where Salesloft renders the tags with no label at all. That last one is what makes the feature fire; requiring a label rejects the only place the tags actually live.
- `[data-testid="popout-logger-container"]` and listbox options are excluded, so the disposition the rep is picking right now never raises an alert about the call they just made.

When Salesloft ships UI changes, these are what break.

## Invariants to preserve

**Dialer**

- `killAndLog` sets the disposition **before** clicking "Log & Complete". Any failed step throws, surfaces "Stopped: … Finish manually.", and leaves the call unlogged — never log with a wrong or missing disposition.
- A `busy` flag serializes flows; hotkeys and clicks are ignored while one runs.
- In-page hotkeys are suppressed while typing (`isTyping()`).
- **The overlay never moves or resizes with its content.** It is pinned bottom-left; the button column is a fixed 240px and the transcript pane a fixed 300×152, so status text wraps and transcript lines scroll rather than pushing anything around. Its size changes for exactly one reason — transcription being switched on or off, which adds or removes the pane. Anything that makes it grow with what it is displaying re-introduces the jumping the fixed sizes exist to stop.
- **Nothing renders over the Salesloft page.** The contact alert appears only in the floating panel and as the tinted line inside the overlay (`window.__slOnContactAlert`); do not bring back a floating toast.

**Transcription**

- **The passthrough is load-bearing.** Tab capture removes audio from normal playback; `offscreen.js` must reconnect the source to `AudioContext.destination`. If the graph cannot be built or the context will not leave `suspended`, capture is torn down entirely — no transcription always beats a broken call. This cannot be caught by any test that is not a real call.
- **The transcription path never clicks Salesloft controls.** Detection observes; `content.js` acts. Keep them separate so a detection bug can never mis-log a call.
- **Transcript text on the page must never be read back as page content.** The pane puts whatever the prospect said inside the overlay, so a prospect saying "meeting scheduled" sits in the DOM as those exact words. `alerts.js` is safe from it twice over — `#sl-hotkey-overlay` is in its `EXCLUDE` list, and its MutationObserver skips mutations inside the overlay — and both have to stay that way, or the transcript starts raising contact alerts about itself.
- **Never fail loudly mid-call.** No modal, alert, focus steal, or anything that pulls attention. Failures surface as a quiet status line, and `DEGRADED` is a normal state.
- **No audio to disk, ever.** Nothing in `server/` opens a file for audio; `config.py` refuses to start if `storage.save_audio` is true. Buffers are freed the moment inference returns.
- **VAD gating is not an optimisation.** Whisper pads every input to 30s, so a 2s slice costs about what a 25s one does. Silence must produce zero invocations.
- **Backpressure coalesces, it does not drop.** Merging queued utterances costs the same as one inference and keeps all the speech; dropping is the last resort when a merge would exceed the 30s window.
- **Capture arming is a Chrome constraint, not a bug.** A tab capture stream requires the extension to have been invoked on that tab, and the invocation authorises whichever tab was active. So the from-any-tab hotkeys cannot *start* capture — only `Ctrl+Shift+8` (or a command fired) with Salesloft in front can. It persists across tab switches afterward.
- Scope stays `https://app.salesloft.com/*` plus `http://127.0.0.1:8765/*`; the server binds to `127.0.0.1` and validates the WebSocket origin.
