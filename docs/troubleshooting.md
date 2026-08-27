# Troubleshooting

## Setup

**"pip.exe is not recognized" while installing.** A previous setup run was
interrupted part-way through pip upgrading itself. On Windows pip cannot
overwrite the files it is running from, so it renames its own package to `~ip`,
unpacks the new copy, and regenerates `Scripts\pip.exe` last. Stop it in the
middle and you are left with a working `python -m pip` and no `pip.exe`. The
giveaway is a `WARNING: Ignoring invalid distribution ~ip` line -- any
`~`-prefixed folder in `.venv\Lib\site-packages` is a tombstone from an
interrupted install.

Recover with:

```powershell
Remove-Item -Recurse -Force .venv\Lib\site-packages\~*
.venv\Scripts\python.exe -m pip install --force-reinstall --no-cache-dir pip
```

Then double-click **Install.cmd** again. Deleting the whole `.venv` folder and
re-running setup also works and takes about the same time.

**Setup says Python is too old, or typing `python` opens the Microsoft Store.**
The Store alias is a stub named `python.exe` that opens the Store and exits
without running anything. Turn it off in Settings > Apps > Advanced app settings
> App execution aliases -- switch off both python entries -- then install Python
3.10 or newer from python.org and run setup again.

**Setup stops on "CPU-only PyTorch install failed".** Usually a network blip
against `download.pytorch.org`. Just run it again. Setup stops rather than
carrying on because the next step would satisfy the same dependency from
ordinary PyPI, which quietly installs about 2.5GB of CUDA libraries this
service never uses.

**`.venv` is several gigabytes.** A CUDA build of PyTorch got installed at some
point. Delete the `.venv` folder and double-click **Install.cmd** again; current
setup checks for this and refuses to finish if it happens.

---

## The dialer

**No buttons on the Salesloft page.** Refresh the tab. If they still do not
appear, check that **Buttons on Salesloft page** is on in settings.

**Pressed the shortcut and nothing happened.** Make sure a Salesloft tab is open
in Chrome, then refresh it once.

**Status says "Stopped" or "Timed out".** The extension could not find a button
it expected. Finish logging that call by hand. If it happens on every call,
Salesloft probably changed their UI and the selectors in `content.js` need
updating.

**Wrong disposition logged.** The **Disposition** setting must match the
Salesloft dropdown word for word, including capitalisation.

---

## Transcription

### I cannot hear the prospect

**Stop using transcription immediately** — turn it off in settings — and report
it. This is the failure mode the whole design is built to prevent, and if it
happens the passthrough is not working as intended.

Before concluding that, check the more likely cause below.

### I can hear nothing, but only in my headset

`AudioContext.destination` plays through the **Windows default output device**,
not whatever Salesloft is set to use. If your headset is selected inside
Salesloft but your laptop speakers are the Windows default, the call audio comes
out of the speakers.

Two fixes, either works:

1. Set your headset as the Windows default output device
   (Settings → System → Sound → Choose where to play sound), or
2. Pick the headset explicitly under **Call audio output** in the extension
   settings.

Device names in that dropdown may be blank until Chrome has been granted
microphone access once — the entries still work, they are just unlabelled.

### "Transcription not armed"

Chrome only allows tab capture to start when the extension was invoked on the
tab being captured, and the invocation applies to whichever tab was in front at
that moment.

**Fix:** switch to the Salesloft tab and press `Ctrl+Shift+8`. Capture then
persists across tab switches for the rest of the call, so you can go back to
LinkedIn or ZoomInfo as usual.

What does *not* arm capture: the F8/F9 in-page hotkeys, the on-page overlay
buttons, the floating panel buttons, Salesloft's own Call button, or any hotkey
pressed while a different tab is in front.

### "Transcription offline"

The local server is not running or is not reachable.

1. Start it: `powershell -ExecutionPolicy Bypass -File scripts\start-server.ps1`
2. Click **Test server** in the extension settings to confirm.

The extension reconnects on its own with backoff, so starting the server
mid-call recovers without a refresh. Audio that arrives while disconnected is
dropped, never buffered — the gap in the transcript is expected.

### The transcript falls further behind as the call goes on

Cumulative drift means the machine cannot keep up with this model. Latency that
holds steady at 4 seconds is usable; latency that grows to 30 is not.

1. Check the panel for `BEHIND` — that is the server coalescing utterances under
   load, which recovers the text but signals it is at its limit.
2. Re-run the Phase 0 benchmark and drop to a smaller model:
   `python scripts/benchmark.py --models base.en,distil-small.en sample.wav`
3. Set the winner in `server/config.yaml` under `transcription.model`.

### Lines appear that the prospect never said

Whisper hallucinates on silence, hold music and noisy lines. The filters in
`server/transcription.py` catch most of it. To tighten them, in
`server/config.yaml`:

- Lower `max_no_speech_prob` (0.6 → 0.4) to reject more aggressively
- Raise `min_avg_logprob` (-1.0 → -0.7) to demand more confidence
- Raise `vad.min_utterance_ms` (250 → 400) so short bursts never reach the model

Hold music is the common trigger. Use the panel's pause button while on hold.

### Timestamps look approximate, with a `~` next to them

The server merged several utterances into one inference because it was falling
behind. All the speech is preserved; only the timing within that line is
approximate.

### Transcription is missing the first word of sentences

Increase `vad.pre_roll_ms` in `server/config.yaml` (300 → 500). That is how much
audio before speech onset is included, and a slow VAD attack clips plosives.

### Nothing is transcribed at all, but the server says ready

- Confirm the call is actually detected: the panel timer should be running.
- Confirm audio is reaching the tab — you should be able to hear the prospect.
- Check the server console. If it logs no utterances, the VAD is not seeing
  speech; lower `vad.speech_threshold` (0.5 → 0.35) for quiet lines.

### CPU is pegged during calls

- Confirm `vad.enabled: true`. With gating off, Whisper runs continuously.
- Idle CPU with no speech should be under 5%. If it is not, the VAD is
  misfiring on line noise — raise `vad.speech_threshold`.
- Drop to `base.en` or `distil-small.en`.

### Salesloft changed their UI and calls are no longer detected

Detection degrades to IDLE rather than erroring, so the dialer keeps working and
transcription simply does not auto-start. Use `Ctrl+Shift+8` to start it
manually while this is fixed.

The fix goes in `extension/call-detect.js` — `END_CALL_LABELS` and the tier
order. Never match generated styled-components classes (`.sc-imkklV`); they
change on every Salesloft deploy. `tests/test_salesloft_detection.js` covers the
tier behaviour.
