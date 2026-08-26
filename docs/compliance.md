# Compliance and consent

**Status: IT approved. Legal/compliance sign-off still outstanding.**

This is a gate, not a checklist item. It must be resolved before the extension
captures audio on a live call.

## Sign-off record

| Gate | Owner | Status | Date |
|---|---|---|---|
| Corporate IT — local Python service, model downloads, loopback socket on a company laptop | IT | **Approved** | 2026-08-26 |
| Legal/compliance — live transcription without retention, and disclosure requirements | Jama compliance owner | **Outstanding** | — |

Update this table when the second gate clears. If disclosure turns out to be
required, record the exact wording here alongside the approval.

## Why IT approval is not the same approval

The IT question was "may this software run on this machine". The compliance
question is "may this conversation be captured", and they have different owners
and different failure modes. What IT cleared:

- A local Python service listening on `127.0.0.1:8765`
- Whisper model weights downloaded and cached locally
- A Chrome extension loaded unpacked with `tabCapture` permission

What remains open is below.

## The open question

Local processing addresses data handling. It does not address consent.

Wiretapping and eavesdropping statutes generally regulate the **interception or
capture** of a conversation, not where the resulting data is stored. That audio
is discarded after inference is a strong privacy posture, but it is not
established as a legal exemption anywhere, and real-time transcription without
retention is largely untested ground.

Specifics that make this non-trivial:

- Oklahoma is one-party consent. Many states an outbound medtech program dials
  into are not — including California, Pennsylvania, Illinois, Florida,
  Massachusetts and Washington.
- Salesloft's native recording has disclosure infrastructure built around it. A
  separate capture path bypasses that infrastructure entirely.
- Interstate calls introduce genuine ambiguity about which state's law governs.

**Required before the first live call:** written guidance from whoever owns
compliance at Jama on whether live transcription without retention is permitted,
and if so under what disclosure conditions.

This document is not legal advice.

## What the implementation already guarantees

These are properties of the code, verifiable by reading it, and they narrow the
question rather than answer it:

- **No audio is written to disk.** No function in `server/` opens a file for
  audio. `config.py` refuses to start if `storage.save_audio` is ever set true,
  precisely so the flag cannot be flipped as if it were a feature.
- **No audio leaves the machine.** The server binds to `127.0.0.1` and rejects
  any WebSocket origin that is not the extension. There are no outbound network
  calls anywhere in the service.
- **Buffers are freed at inference.** `Session._worker` drops each utterance's
  audio the moment `transcribe()` returns.
- **Transcript persistence is off by default** and text-only. Filenames carry a
  timestamp and an opaque call id — never a prospect name or phone number.
- **V1 captures one side.** Saved transcripts record
  `"source": "prospect_audio_only"` so no future consumer can mistake them for a
  full conversation.

## If disclosure is required

Design it into the flow rather than bolting it on. The pieces that would need to
exist:

1. **An unmissable indicator** while capture is live — the panel's `● LIVE` dot
   is a starting point but was designed to be glanceable, not to be a legal
   notice.
2. **A scripted disclosure line** surfaced in the panel at call start, so the rep
   reads it before the prospect speaks.
3. **A blocking gate**: `autoStartTranscription` should refuse to start until the
   disclosure has been acknowledged for that call.

None of that is built. It is deliberately not built, because the wording and the
trigger conditions are compliance's to specify, and guessing at them would
produce something that looks compliant without being so.

## Phases and this gate

Phases 0 and 1 use recorded sample audio, not live calls, and can proceed while
this is pending. Phase 2 (capture on a live Salesloft call) is where the gate
binds.

Open question worth ten minutes before Phase 0: does the current Salesloft plan
already include Conversations-native transcription, and if so does the
live-during-call gap still justify this? Ask the Salesloft admin.

If existing Salesloft call recordings are used as Phase 0 benchmark input, that
raises its own question about the use of recorded prospect audio — worth
including in the same compliance conversation rather than a separate one.
