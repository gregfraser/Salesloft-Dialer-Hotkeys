# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Two things that ship together:

1. **A Chrome extension** (Manifest V3, plain JavaScript — no build system, no bundler, no `package.json`) that automates Salesloft cadence dialing. Three actions — `kill-and-log` (end call → set disposition → click "Log & Complete"), `start-call`, and the optional `not-in-service` (set its own disposition → "Log Only" → remove the person from the cadence) — triggerable by global hotkeys, an on-page overlay, or a floating panel window.
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
pip install numpy pytest pyyaml fastapi httpx  # all the Python suite needs (no torch, no whisper)
python -m pytest tests/                        # 93 tests: VAD, queue, protocol, session, benchmark
python -m pytest tests/test_vad_endpointing.py # a single file
python -m pytest tests/ -k merges -q            # a single test by name
node --test tests/test_salesloft_detection.js  # DOM detection (21)
node --test tests/test_hotkeys.js              # key bindings: record, match, label (23)
node --test tests/test_pcm_worklet.js          # audio downsampling (14)
node --test tests/test_transcript_format.js    # shared transcript formatting (10)
node --test tests/test_contact_page.js         # which routes are a contact (8)
node --test tests/test_contact_alert.js        # tag matching (7)
```

`node --test tests/` does **not** work — the directory is named `tests` and the files use underscores, so neither matches Node's default discovery patterns. Name the file explicitly.

The DOM automation is the part most likely to break and the part `node --test`
cannot reach, so it has a browser suite of its own in `tests/browser/`
(Playwright, installed there on demand — the extension keeps no `package.json`,
and git ignores whatever npm writes in that directory):

```bash
cd tests/browser && npm install playwright && npx playwright install chromium
node behaviour.mjs   # the Not in Service flow, the pane, the not-armed state (56)
node regress.mjs     # the two older flows, the plate's geometry, the compact bar (28)
```

`mock.html` is a Salesloft-shaped page built from structure and accessible
names only, never a generated class — the same rule `content.js` follows. Make
it as awkward as the real page — every option on `__buildSalesloft()` exists
because it caught a bug that the unit tests and a screenshot both missed: the
`confirm` dialog is `position:fixed`, `loggerIsDialog` gives the popout
`role="dialog"`, `decoys` fills the feed with pills whose entire text is the
disposition being looked for, `nameFrom` moves the cadence control's accessible
name between four places, `listPage` drops the contact marker, and
`downshiftMenu` keeps the disposition menu in the DOM while it is closed. See
`tests/browser/README.md`.

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

`tests/browser/` drives the flows against a mock page and catches most
selector and state bugs; it is not a substitute for the pass below, which is
the only thing that exercises real Salesloft, real tab capture and the real
audio path.

Manual, against the live Salesloft app:

1. `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`.
2. After editing `background.js`, `manifest.json` or `call-detect.js`: reload the extension card.
3. After editing `content.js`, `alerts.js`, `defaults.js` or `spring.js`: reload the extension **and** refresh the `app.salesloft.com` tab — `defaults.js` and `spring.js` are content scripts too, so the page keeps running the old copies until it reloads.
4. After editing `offscreen.js` or `pcm-worklet.js`: reload the extension and restart capture (`Ctrl+Shift+8` twice) — the offscreen document is only recreated on the next capture.
5. After editing `panel.*` or `settings.*`: close and reopen that window/popup.

## Architecture

Four execution contexts in Chrome plus one Python process. Understanding any feature means tracing it across several. `docs/architecture.md` has the full diagram and rationale.

- **`background.js`** (service worker) — the relay and the owner of transcription state (`IDLE → STARTING → TRANSCRIBING → FINALIZING`, plus first-class `DEGRADED`). Finds the most-recently-accessed Salesloft tab, forwards dialer actions, and on failure injects the content scripts via `chrome.scripting` and retries once. Owns the panel window (id in `chrome.storage.session`, so it survives worker sleep), the offscreen document lifecycle, and capture arming.
- **`content.js`** — runs only on `https://app.salesloft.com/*`, and renders its overlay only on a contact's page (`syncOverlay()`); performs the DOM automation, renders the optional overlay (buttons, contact-alert line, status, and — when transcription is on — the live transcript pane), handles the in-page bindings (←, → and ↑ by default). Guards double-injection with `window.__slHotkeysLoaded`.
- **Content-script order in `manifest.json` is load-bearing**: `defaults.js`, `spring.js`, `call-detect.js`, `content.js`, `alerts.js`. All five share one isolated world and talk through globals, so `content.js` needs the defaults, the springs and the detector already defined, and `alerts.js` runs last because it calls the `window.__slOnContactAlert` hook that `content.js` registers. `background.js` recovers a failed send by injecting a copy of that list via `chrome.scripting.executeScript` (`files:` in `sendToSalesloft`), and the two lists have to be kept identical by hand — the fallback used to be missing `spring.js`, which made `content.js` throw on `window.slSpring` whenever it was injected that way.
- **Orphaned content scripts are a normal state.** Reloading or updating the extension leaves the old content scripts running in the page with `chrome.runtime` gone — accessing it throws. Every `chrome.*` send from a content script goes through a guard (`safeSend()` in `content.js`, try/catch in `alerts.js`) so the DOM flows still complete from a stale script, and `buildOverlay()` always **replaces** an existing overlay rather than keeping it, because a leftover one is wired to the dead context — `syncOverlay()` keeps that true by treating an overlay it did not build as missing. Preserve both patterns in new content-script code.
- **`call-detect.js`** — call-state detection, **observe only**. Takes its DOM access as injected functions (`elements`, `isVisible`) so it is testable without a DOM.
- **`alerts.js`** — reads the Disposition / Sentiment tags already on the contact's page, **read only**. It renders nothing of its own: the colour-coded alert shows in the floating panel (via a `contact-alert` message) and as a subtle line inside the on-page overlay (via the `window.__slOnContactAlert` hook `content.js` registers in their shared isolated world). `content.js` also reads `window.__slContactAlert` for its status line.
- **`offscreen.js`** + **`pcm-worklet.js`** — hidden document holding the `AudioContext`, the mandatory passthrough, the downsampler and the WebSocket. MV3 service workers terminate after ~30s and cannot hold `MediaStream`s, which is why this exists.
- **`spring.js`** — the one motion primitive, loaded by all three UI surfaces (content script via the manifest, panel and settings via a `<script>` tag). A single rAF loop over springs that add themselves when they have somewhere to go and drop out when they settle, so an idle plate costs no frames. Ported from the design prototype rather than reimplemented. Exports `slSpring`, `slPressable`, `slSlot` and the drag maths (`slBand`, `slProject`, `slClamp`, `slMix`, `slReducedMotion`).
- **`panel.*`** / **`settings.*`** — thin UIs.
- **`server/`** — `main.py` (FastAPI + session), `vad.py` (Silero + `Endpointer`), `transcription.py` (`UtteranceQueue`, filters, metrics), `websocket.py` (protocol), `audio.py`, `config.py`.

### Settings

`chrome.storage.sync` holds dialer settings (`floatingPanel`, `pageOverlay`, `compactBar`, `disposition`, `notInService`, `notInServiceDisposition`, `hotkeys`), contact-alert settings (`alertsEnabled`, `alertTags`, `alertStrict`) and transcription settings (`transcription`, `outputDeviceId`, `serverUrl`, `healthUrl`). With `transcription` on, auto-start is unconditional — it is a behaviour, not a setting. `transcription` also decides whether the on-page overlay carries the transcript pane, so toggling it rebuilds the overlay.

**No transcript is ever downloaded automatically.** A cadence is dozens of dials and almost none of them are worth a file, so a save happens only from a click on a ↓ button. Both UIs enforce this; a "save it for them" convenience is the thing not to add back. Chrome independently forbids it on the page side anyway — a web page gets one uninvited download before Chrome starts asking the user's permission for the rest, so an automatic per-call save from `content.js` would put a permission bubble on the Salesloft page partway through a call block.

What *is* automatic is the offer. `stopTranscription()` waits for the server to drain the queue and only then calls `offerTranscriptSave()`, which sends `transcript-unsaved` to both channels; each UI answers by putting a line in its status and highlighting its ↓ button, and ignores it when nothing is unsaved. The flush is the point of the wait: offering on the call-end `call-state` message instead would mean the rep saves a file missing the call's last utterance.

**`extension/defaults.js` is the single definition** — loaded as a plain script by the content script (via the manifest), the service worker (`importScripts`), and both HTML pages (`<script>` before their own). Add new settings there only; do not reintroduce per-file copies. It also holds what the panel and the on-page transcript both need to agree on — the alert palette, and the transcript formatters (`slFormatClock`, `slTranscriptText`, `slTranscriptFilename`) — so a line reads the same in either and a saved file does not depend on which one wrote it. **The contact alert renders the tag and nothing else.** Both surfaces put the tag Salesloft wrote — "No Interest" — on screen, and the palette carries the urgency, so a headline in front of it either repeats the tag ("Meeting already scheduled — Meeting Scheduled", which also spent the banner's only line) or tells the rep whether to dial, which is theirs to decide. There is no `SL_HEADLINE`; do not add one back. Its `module.exports` is what makes those testable under `node --test`.

Nothing sends messages about settings changes: the background and content script each react to `chrome.storage.onChanged`.

### Key bindings

**There are two layers and neither replaces the other.** `chrome.commands` is
the only way to fire an action from another tab, and its picker takes a Ctrl or
Alt combination and nothing else — no number pad, which is where a rep working a
cadence keeps a hand — and it silently leaves a command unassigned when the
suggested key is already taken by something else installed. So the extension
also keeps its own bindings (`hotkeys` in storage, `kill-and-log`,
`start-call` and `not-in-service`) and listens for them itself, in `content.js`
and `panel.js` — the only two places a key event reaches this extension at all.
Both routes end at the same functions. The three shipped bindings are three
arrows under one hand — left and right for the pair, up for `not-in-service`.
A bound arrow stops scrolling the Salesloft page while the overlay is loaded,
since the in-page handler `preventDefault`s whatever it matches; that was
already true of left and right. Empty stays a normal value, and a rep who wants
the key back clears it in the popup.

**A binding is `e.code`, not `e.key`**, canonicalised by `slHotkeyFromEvent()`
in `defaults.js` as `Ctrl+Alt+Shift+Meta+<code>` with the modifiers always in
that order. The pad's 1 and the 1 above the letters are both `'1'` to `key`, and
with Num Lock off that same key reads `'End'` — the code is the physical key, so
a number pad binding survives Num Lock either way. Recording and matching both
go through that one function, so a press cannot canonicalise differently from
the binding it is meant to match; `slHotkeyMatches()` is the compare. Empty is a
normal value and means the action has no key of its own.

**What a button says is what fires it.** The overlay's keycaps, the panel's
sub-lines and the popup's list are all rendered from the binding in storage and
from `chrome.commands.getAll()` — never from the manifest's `suggested_key`,
which is only a suggestion Chrome is free to ignore. A keycap appears only for a
key that actually does something, so an action with neither reads as unbound
rather than claiming a shortcut the rep does not have. `slHotkeyLabel()` has a
compact form for the keycaps, where two of them share the 214px column, and a
full one for the popup.

**One key per button, and it is the rep's own.** The overlay's keycap and the
panel's sub-line show the binding from storage, and fall back to
`chrome.commands.getAll()` only for an action that has no binding of its own.
Both used to show at once, and the pair stopped reading as a pair the moment the
rep rebound anything: Chrome takes the suggested keys it can get and silently
drops the ones already claimed, so it typically holds one of the two actions and
not the other — rebind to F11/F12 and one button reads "F11 Ctrl⇧9" while its
neighbour reads "F12". The eye lands on the difference rather than the keys. The
button is a reminder of what is under the hand; the `title` on both surfaces
still names both keys and says where each works, and the popup remains the full
account of what Chrome actually has.

**One key, one action.** Recording a key that the other action already holds
moves it across (`settings.js`, `onRecordKey`): the other row goes to "Not set"
where the rep can see it, rather than the press being silently refused or two
buttons firing on one key. Esc and Tab are `SL_RESERVED_KEYS` and cannot be
recorded, because the popup uses them to cancel and to move between fields.

Transcription deliberately has no binding of its own: capture arming makes a
page keypress able to stop capture but never to reliably start it (see
`docs/architecture.md`), so the popup shows it as a Chrome shortcut and says
why.

### Message protocol

`{type:'dialer-action', action}` flows toward the content script; `{type:'status', msg, kind}` flows back. The action names double as the manifest command names, the `hotkeys` storage keys and the handler dispatch keys — keep all four aligned when adding an action.

`{type:'command-keys'}` is the one message the worker **answers** rather than relays (`sendResponse`, with `return true` to keep the channel open); `chrome.commands.getAll()` exists only in extension contexts, so a content script cannot read its own shortcuts. The panel and the popup call it directly instead.

Transcript and status messages from the offscreen document reach the panel **directly** via `chrome.runtime.sendMessage`. The service worker observes them for its state machine and deliberately does not re-broadcast on that channel; re-broadcasting would render every transcript line twice in the panel.

Content scripts receive none of those broadcasts, so the on-page transcript is fed by the worker relaying each one on with `chrome.tabs.sendMessage` (`forwardToSalesloft`). That is a separate channel from the broadcast — it cannot double a line the panel already drew — and it is the only reason the worker touches transcript traffic at all. `transcription-paused` is echoed to **both** channels, because pause is one piece of capture state that two UIs display.

### DOM automation (the fragile part)

`content.js` drives Salesloft's React UI with no API access:

- Buttons found by exact (case-insensitive, whitespace-collapsed) visible text — "End Call", "Log & Complete", "Call" — scoped to `[data-testid="popout-logger-container"]` when logging.
- `not-in-service` takes a different branch of the same UI, and its steps come from a recording of the flow done by hand rather than from guesswork: the split button's caret (`[data-testid="menuToggle"]`, accessible name "Open Log only or complete only menu") → the menu's "Log Only" → the cadence's own control, matched on the accessible name "Remove person from cadence" because it is an icon button with no text. A confirmation dialog may or may not follow; its *absence* is a normal outcome (hence `CONFIG.confirmTimeout`, 1.5s, not the 8s step timeout), but a dialog that appears with no recognised button throws rather than being left open. Two rules make that work and both were bugs first: the dialog is found with `isShown()` rather than `visible()`, because **`offsetParent` is null for a `position:fixed` element** and every modal is one — `visible()` stays correct for the controls *inside* a container and wrong for the container itself; and only a dialog that was **not already open** when the removal was clicked counts, because Salesloft's own logger popout carries `role="dialog"` and a document-wide lookup matched the popout the flow had just been driving.
- The disposition dropdown is a Downshift combobox, located via `[id$="toggle-button"]` / `[aria-haspopup="listbox"]` near the text "Disposition"; the option is matched against the `disposition` setting exactly — **inside the list that toggle just opened** (`aria-controls` / `aria-owns` on the toggle or the input beside it, the `-menu` twin of a `-toggle-button` / `-input` id, or whichever list was not **on screen** a moment ago), never across the document. "On screen", not "in the DOM": Downshift keeps its menu rendered while closed, so recording every list that existed before the click ruled out the one the toggle opened, and the flow stopped on `could not find "No Answer"` with the option in plain view. The candidates are re-resolved on every poll, and a miss puts the toggle's attributes and each candidate list's items in the console (`dumpDisposition()`). The option search used to be `[role="option"], [role="listbox"] li, ul li` page-wide, and `ul li` matches every list item Salesloft renders: on a contact logged "Not in Service" a dozen times, the activity feed and the cadence sidebar are full of elements whose entire text is exactly the disposition being looked for, so the click landed on one of those and the field stayed empty. The selection is then **read back** before anything logs, because a click that misses is otherwise silent and the next step logs the call without a disposition. It is read from the **field**, not the toggle: Salesloft swaps the chevron for a clear (×) button once a value is picked, so the toggle that was clicked is detached by then and the value sits in the input beside it. `dispositionField()` takes the nearest ancestor of the toggle holding exactly one input, captured before the click; `dispositionValue()` reads that input, or the field's text with any list inside it removed. Reading the toggle alone left the flow on "Setting \"No Answer\"…" with the field plainly reading No Answer.
- **An icon button is named by more than `aria-label`.** `accessibleName()` reads `aria-label`, then `aria-labelledby`, then the `title` attribute, then the `<title>` inside its own artwork, then its text — and the cadence control needs that last-but-one: Salesloft names "Remove person from cadence" from the `<title>` of its SVG, which is what a recorded `::-p-aria(…) >>>> ::-p-aria([role="graphics-symbol"])` was saying. Reading the attribute alone found nothing, so the flow logged the call and then timed out. Where text content is the only name left, the **shortest** match wins, so a panel that merely mentions the words loses to the button itself.
- **A timeout names what it was waiting for.** `waitFor(fn, timeout, interval, what)` — "Stopped: could not find the Remove from cadence control" is a bug report; "Timed out waiting for element" is not. When the cadence control is the one that is missing, `dumpNames()` also puts every named control on the page into the console, because by then the call is logged and the rep has to finish by hand.
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

- `killAndLog` sets the disposition **before** clicking "Log & Complete". Any failed step throws, surfaces "Stopped: … Finish manually.", and leaves the call unlogged — never log with a wrong or missing disposition. `runNotInService` keeps the same rule and adds one: the cadence removal goes **last**, because a person removed from a cadence with no call logged against them is the worse half-state of the two.
- **The third control arms before it fires, and that is its confirmation.** `not-in-service` is the only thing in this extension that takes a person out of a cadence, and undoing it means finding them and adding them back by hand. A modal is out (nothing here steals focus mid-call), so the control itself asks: one press turns it red and changes its label to "Remove from cadence?", a second within 3s commits, and the window lapses on its own. Both surfaces implement it, and both disarm when the overlay is replaced or the setting goes off — a press half-made against a control that is no longer there must not survive. **Whoever asked the question owns the answer**: the panel confirms on its own surface and sends `confirmed: true`, which the content script runs straight through, because arming a second time there made the panel's confirming press do nothing and put the real commit two presses later inside a 3s window. And arming never happens where it cannot be seen. Two surfaces have no strip to turn red — the page controls off entirely, and the compact bar, which deliberately does not carry this control — so `notInService()` refuses on both rather than letting a second keypress remove someone with nothing having asked. The refusal names the full plate and the panel, not "the on-page buttons", because in compact mode the rep already has those on.
- **It is off by default and it shares the base row, never the pair's row.** Putting a third button beside the pair would take width from the two buttons a rep aims at all day. It sits on the row below them instead, next to the status — one 26px line spanning the whole plate. That row is what fixed the balance: the strip used to be 214 wide under a plate that is 278 or 552, so the corner beneath the transcript pane was bare. Its disposition is its own setting for the same reason `disposition` is one: it has to match Salesloft's dropdown text exactly. The strip has **two widths** and which one is in use follows the pane beside it — the full column at 552, its mark and key alone at 278 or 234, where a name will not fit next to a status line that has to hold "Stopped: …".
- **`compactBar` is how the page controls are drawn, not whether.** `pageOverlay` decides if anything is on the page; `compactBar` decides whether that is the full plate or a 42px bar carrying the same status and the same two actions at 26px. The full plate is the default and stays it. The bar has no Not in Service strip — a control that takes someone out of a cadence does not belong on the surface a rep chose because they wanted the plate out of the way — and no transcript pane. It **stands down for the duration of a call**: `reportCallState()` rebuilds on the crossing into and out of `IN_CALL`, because mid-call is exactly when the large targets earn their size. That rebuild is the one place this plate changes size on its own, and it is the trade a rep accepts by choosing the mode rather than one forced on everyone.
- A `busy` flag serializes flows; hotkeys and clicks are ignored while one runs.
- In-page key bindings are suppressed while typing (`isTyping()`) — which is what makes a bare letter a usable binding at all — and ignore auto-repeat, so a held key cannot queue flows behind `busy`.
- **The keys on the buttons are read back, never assumed.** The overlay and the panel print the rep's binding and whatever `chrome.commands.getAll()` reports, and print nothing for an action that has neither. Hard-coding `Ctrl⇧9` there is how the buttons came to claim a shortcut Chrome had left unassigned.
- **The plate can be dragged, but it still never moves or resizes with its *content*.** It starts
  bottom-left and the rep can throw it anywhere; the position is a `transform` offset persisted in
  `chrome.storage.local` — local, never `sync`, because it is a position on this monitor — rubber-banded
  while dragging, carried to rest by a spring holding the release velocity, and re-clamped on resize so a
  smaller window can never strand it off screen. Everything the rep aims at is still a fixed size: the
  button column 214px, the transcript pane 308px, both exactly `PANEL_HEIGHT` (104), so the two finish on
  the same line and transcript lines scroll rather than push anything around. The status shares the
  **base row** with the Not in Service strip — a sentence reads better across the plate than down 214px —
  and it ellipsises with the whole of a long "Stopped: …" in the tooltip, which is what stops it resizing
  anything (`width:0;min-width:100%` on that row keeps a long line from deciding the plate's width). The
  call timer and the line count live on that row too, in every state: they used to be drawn in the
  transcript pane as well, and that duplication is the whole reason the collapsed pane needed 96px to say
  what the line below it was already saying.
- **The status strip is the one place two paths write, so the order between them is fixed.** The click
  path owns it — a flow's "Ending call…" and its "Stopped: … Finish manually." are the rep's only
  account of a call that may now be half-logged. The detection path adds `setCallLive()`: the dot goes
  green and the line reads "Connected" while `call-detect` sees a call, which is what the climbing timer
  beside it had been asserting wordlessly. It is guarded on `busy` for exactly that reason, so it can
  never overwrite a flow mid-way. `buildOverlay()` re-applies the same state directly rather than through
  `setCallLive()` — an overlay rebuilt mid-call (a settings toggle, a stale copy being replaced) must
  open on "Connected" rather than "Ready", but a rebuild is not news and must not re-announce to the
  panel. The panel mirrors the dot off the `call-state` message it already handles, and takes the text as
  an ordinary relayed status.
- **The contact tag is the one thing allowed to move the layout, and that is deliberate.** It holds
  **no** space until the page scan reports one, then springs the plate open (`slSlot`, a lazily measured
  `scrollHeight` with a negative margin cancelling the stack gap while closed). This reverses the older
  reserved-band rule and supersedes `plans/001-contact-alert-entrance.md` in the design bundle (not in this repo), which
  specified the opposite. The grounds: the scan lands before the rep has decided to dial, so the movement
  is over well before the aim — and a permanently reserved band is ~20px of empty plate on every contact
  that has no tag, which is most of them.
- **Springs and CSS transitions must never share a property.** `spring.js` writes an inline `transform`;
  a `transition: transform` on the same element would ease toward each spring frame, so the motion
  arrives late and overshoots twice. `overlayStyle()`, `panel.html` and `settings.html` therefore
  transition colour and `filter` only — colour is safe precisely because it has no velocity to hand off.
  For the same reason there are no `:active{transform:…}` rules left; the press is `slPressable`, gated on
  `busy` so a click that is about to be ignored does not answer as though it was not. Reduced motion is
  handled inside `spring.js` (checked on every `to()`, not captured once, so the rep can change the OS
  setting without reloading the tab); all the stylesheets still have to stop is the looping LIVE dot and
  the line entrance.
- **Sizes come from `TYPE`, and there are three elevations.** `TYPE` is five sizes named for their use
  (`action` 15, `read` 13, `alert` 12, `caption` 11, `overline` 10) and nothing is set off it. Gaps encode
  grouping: 6 inside the button pair, 10 from the pair to the pane, 8 down the stack. The surface
  vocabulary is shared by all three UIs and is the whole visual system: the plate floats (translucent,
  `backdrop-filter` blurred — the blur is load-bearing, without it the alpha reads as a washed-out solid),
  a **raised** face sits on it (`rgba(255,255,255,.045)` + hairline border + inset top highlight), and an
  **inset** well is cut into it (`#0f1113` + inset shadow) for the transcript and every form field.
  Nothing in this UI is flat.
- **Icons are drawn, not typed, and a pointer target is never under 24px.** The small controls were text
  glyphs (`«`, `»`, `⏸`, `↓`, `⧉`, `✕`, `⊘`) and that is wrong three times over: flex centring centres the
  line box rather than the ink, so the mark sits low in its own button; most of these are not in the UI
  font and arrive from whatever fallback the machine has, at whatever weight it draws; and there is no way
  to match stroke weights across them. `SL_ICONS` in `defaults.js` is one inline-SVG set shared by the
  overlay and the panel. The same rule makes a keycap an `inline-flex` box with an explicit `line-height`
  and a minimum size instead of bare padding — a single character in `padding:1px 5px` sat in a 14px
  sliver, and `letter-spacing` applies after the last character too, so a one-character cap was pushed
  left of its own middle.
- **Minimising hides the reading, not the transcript.** The old rail beside the pane is gone — its
  controls now live in the pane's own header — so minimising collapses the pane onto a rail rather than
  away entirely, and the light, the toggle, pause and save all stay reachable while no captured line is
  lost; capture itself is untouched. Collapsed it is **34px**: one column of 24px controls with the light
  above them and no words at all, at the row's full `PANEL_HEIGHT`. It could shrink that far only because
  the timer and the line count moved to the base row — drawn in both places, they were what kept an
  earlier 96px version that wide, saying on the plate what the line below it already said. It must never
  go to `height:auto`; that left a header hanging at the top of the row with bare plate under it, the one
  place on this plate where a control did not end where its neighbour did. The design prototype draws the
  pane open only and
  collapses it to zero width, which would take the restore control with it; collapsing to the header is
  the smallest thing that keeps its shape without putting a control out of reach. The flag lives in
  `txView` rather than storage, so it survives an overlay rebuild (a settings toggle, a stale copy being
  replaced) but not a page reload.
- **"Not armed" is a state, not an error, and it is drawn like one.** Capture arming is a Chrome
  constraint, so the pre-state before a rep has armed once is normal and one keypress ends it. It reports
  as its own `notarmed` state and says which key **read back from `chrome.commands`**, never the manifest's
  `suggested_key` — hard-coding `Ctrl+Shift+8` there is the same defect as hard-coding `Ctrl⇧9` on a
  button, and `armingKey()` in `background.js` is what keeps it honest. How loudly it says so is the rest
  of the invariant, and the bar is low: it is the pane's own **placeholder**, in the same corner, size and
  italic grey as "Waiting for the call to start…", so it occupies space that had nothing in it. It never
  covers captured lines (with entries on screen the header word carries it alone), it stays out of the
  status strip — whose error colour belongs to a call that may now be half-logged — the explanation of
  *why* Chrome works this way lives in the pane's tooltip rather than on screen, and the only colour
  anywhere is the header dot. A banner across the pane, an amber word, or the status strip are each a
  louder answer than a normal state deserves.
- **Nothing renders over the Salesloft page.** The contact alert appears only in the floating panel and as the tinted line inside the overlay (`window.__slOnContactAlert`); do not bring back a floating toast.
- **The overlay belongs to a contact, not to Salesloft, and the logger popout is a weaker signal than it looks.** It is drawn only where one person is on screen — `slIsContactUrl()` in `defaults.js` matches the route (`/app/people/{id}` and friends, never the People list), and `content.js` falls back to `[data-testid*="person-detail"]`. The popout (`[data-testid="popout-logger-container"]`) used to count on its own, and it should not: it opens over whatever the rep was on and *stays* open, so on a cadence's People list the plate appeared beside 170 rows with nothing dialled. But it is also the only thing on screen once a rep dials from that list, and taking the buttons away mid-call is worse than showing them early — so the popout counts only while `lastCallState === 'IN_CALL'` or a flow is `busy`. Browsing a cadence gets nothing; calling in one gets the buttons wherever it was started from. Salesloft is a single-page app, so `syncOverlay()` re-decides on every re-render rather than once at injection, and it never removes the overlay while `busy` — a flow mid-way through logging a call keeps its status line.

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
