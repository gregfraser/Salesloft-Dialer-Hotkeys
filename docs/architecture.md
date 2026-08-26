# Architecture

Two processes, four execution contexts. Understanding any transcription feature
means tracing it across all of them.

```
┌────────────────────────── WINDOWS 11 ──────────────────────────┐
│                                                                │
│  ┌──────────────────────── CHROME ──────────────────────────┐  │
│  │                                                          │  │
│  │  Salesloft tab                Service worker             │  │
│  │  ┌────────────┐               ┌──────────────────────┐   │  │
│  │  │  Dialer    │──── audio ───▶│  background.js       │   │  │
│  │  │  (Twilio   │               │  commands, arming,   │   │  │
│  │  │   WebRTC)  │◀── passthru ──│  state machine       │   │  │
│  │  └────────────┘               └──────────┬───────────┘   │  │
│  │        ▲  content.js (observe only)      │ streamId      │  │
│  │        │  call-detect.js ────────────────┤               │  │
│  │        │                                 ▼               │  │
│  │        │  ┌───────────────────────────────────────────┐  │  │
│  │        │  │  offscreen.js                             │  │  │
│  │        │  │  AudioContext(48kHz)                      │  │  │
│  │        └──┼─▶ destination  ← THE REP HEARS THIS       │  │  │
│  │           │  └─▶ pcm-worklet.js ─▶ 16kHz mono Int16   │  │  │
│  │           └──────────────┬────────────────────────────┘  │  │
│  │                          │ binary WS frames              │  │
│  │  ┌───────────────────────┼───────────────────────────┐   │  │
│  │  │  panel.js  ◀──────────┴──── transcript + status   │   │  │
│  │  └───────────────────────────────────────────────────┘   │  │
│  └─────────────────────────────┬────────────────────────────┘  │
│                    ws://127.0.0.1:8765/transcribe              │
│  ┌─────────────────────────────▼────────────────────────────┐  │
│  │  server/  (Python, FastAPI)                              │  │
│  │  PCM ─▶ FrameSplitter ─▶ Silero VAD ─▶ Endpointer        │  │
│  │           silence ─▶ discarded, no inference             │  │
│  │           utterance ─▶ UtteranceQueue ─▶ faster-whisper  │  │
│  │           ─▶ hallucination filters ─▶ text out           │  │
│  │  Audio buffers freed the moment inference returns.       │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

## Why this shape

**Offscreen document, not service worker.** MV3 service workers terminate after
roughly 30 seconds idle and cannot hold `MediaStream` objects. The offscreen
document is Chrome's sanctioned answer: a hidden DOM context that persists while
media is active. Both the audio graph and the WebSocket live there.

**Content script observes only.** `call-detect.js` answers one question — is a
call in progress? — and never touches audio or clicks anything. The dialer
automation in `content.js` is what acts. Keeping them apart is what guarantees a
transcription bug cannot mis-log a call.

**Localhost WebSocket, not HTTP.** Continuous bidirectional streaming with no
per-request overhead, and the Python service stays decoupled from Chrome's
lifecycle. Audio is raw binary; control and transcript messages are JSON.
Base64-encoding PCM inside JSON would inflate payloads 33% for no benefit.

## The passthrough (highest-risk item)

Chrome's tab capture removes captured audio from the normal output path by
design. `offscreen.js` reconnects it explicitly:

```js
source.connect(passthroughNode);
passthroughNode.connect(context.destination);
```

Without that, the rep hears silence and the call is unusable. This does not
appear in unit tests, synthetic tone tests, or any test that is not an actual
call with an actual human on the other end.

Two failure modes beyond simply forgetting the connection:

1. **A suspended AudioContext** produces a silent passthrough even though every
   node is wired correctly. `ensureRunning()` resumes it and throws if it will
   not start, and `startCapture()` tears capture down entirely on that throw. No
   transcription always beats a broken call.
2. **The wrong output device.** `AudioContext.destination` plays through the
   *system default* output. A rep whose headset is selected inside Salesloft but
   is not the Windows default gets working capture, a working passthrough, and
   the call coming out of the laptop speakers. `selectOutputDevice()` applies
   `setSinkId` when a device is configured; otherwise the system default
   requirement is documented in `troubleshooting.md`.

## Capture arming (the non-obvious constraint)

Chrome will not hand out a tab capture stream unless the extension was *invoked*
on that tab, and an invocation authorises the tab that was active at that
moment. This interacts badly with the hotkeys extension's headline feature —
triggering calls from any tab:

| Input path | Can start capture of the Salesloft tab? |
|---|---|
| `Ctrl+Shift+8` / `Ctrl+Shift+0` with Salesloft in front | Yes |
| Same hotkey from LinkedIn or ZoomInfo | **No** — it authorises *that* tab |
| F8 / F9 in-page hotkeys | No — page key events are not invocations |
| On-page overlay buttons | No — page events |
| Floating panel buttons | No — extension-page events |
| Salesloft's own Call button | No |
| Opening the toolbar popup | Yes, for the active tab |

So the rep must invoke the extension once while Salesloft is in front. After
that the `MediaStream` persists across tab switches for the rest of the call, so
the from-any-tab workflow still works — it just cannot *begin* from elsewhere.

`background.js` records the armed tab in `chrome.storage.session` on every
command that fires with a Salesloft tab active, and surfaces a specific message
("press Ctrl+Shift+8 with the Salesloft tab in front") rather than a generic
failure when arming is missing.

## Why utterance gating, not fixed chunks

Whisper pads its mel input to 30 seconds regardless of actual audio length.
Transcribing 2 seconds costs roughly what transcribing 25 seconds costs. Three
consequences shape the design:

- **Fixed-interval chunking is pathological.** Slicing every 2 seconds means
  paying near-full inference cost 30 times per minute of speech.
- **VAD gating is load-bearing, not an optimisation.** Complete utterances
  (typically 2–8 seconds separated by natural pauses) cut invocation count by
  about an order of magnitude *and* produce better text, because the model sees
  whole phrases rather than words cut mid-syllable.
- **Latency is measured from end of utterance**, not from start of speech. The
  honest number is: prospect stops talking, then N seconds later text appears.

## Backpressure: coalesce, not drop

When the queue exceeds `max_queue_depth`, `UtteranceQueue` merges the two oldest
utterances (with 200ms of silence between them) rather than discarding the
oldest. Given the 30-second padding above, transcribing three queued utterances
as one concatenation costs about what transcribing the shortest alone would — so
merging recovers all the speech a drop policy would have lost, at no extra
inference cost. Dropping remains only for when a merge would exceed the model's
window. Coalesced lines are flagged `merged` on the wire and marked `~` in the
panel, because their internal timestamps become approximate.

## Hallucination filtering

Whisper invents fluent text on silence, hold music and line noise. Mid-call a
hallucinated line is worse than no line: a rep who reads back something the
prospect never said loses both the deal and their trust in the tool. Four
defences, in order of where they act:

1. `min_utterance_ms` — sub-250ms fragments never reach the model at all.
2. `condition_on_previous_text: false` — stops one bad transcription from
   poisoning every utterance after it.
3. `no_speech_prob` / `avg_logprob` / `compression_ratio` thresholds.
4. A blocklist of known artefacts ("thanks for watching"), applied only to short
   segments — a prospect really can say "thank you".

## Message protocol

Extension internals:

| Message | From → To | Purpose |
|---|---|---|
| `{type:'dialer-action', action}` | panel/SW → content | existing dialer actions |
| `{type:'status', msg, kind}` | content → SW → panel | existing dialer status |
| `{type:'call-state', state}` | content → SW | IN_CALL / IDLE transitions |
| `{target:'offscreen', type:'start-capture', streamId}` | SW → offscreen | begin capture |
| `{type:'transcript', payload}` | offscreen → panel | one transcript line |
| `{type:'transcription-status', state, detail}` | offscreen → SW + panel | connection state |

Transcript and status messages from the offscreen document reach the panel
directly through `chrome.runtime.sendMessage`. The service worker observes them
for its state machine but deliberately does **not** re-broadcast, which would
render every line twice.

Wire protocol to the server is documented in `server/websocket.py`.
