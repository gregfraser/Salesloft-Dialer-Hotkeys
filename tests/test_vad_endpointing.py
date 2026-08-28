"""Endpointing policy tests (PR-5).

These drive `Endpointer` with synthetic speech probabilities, so they run
without onnxruntime, torch or a Silero model present.
"""

import numpy as np
import pytest

from vad import Endpointer

SAMPLE_RATE = 16000
FRAME = 512
FRAME_SECONDS = FRAME / SAMPLE_RATE  # 32ms


def frame(value: float = 0.1) -> np.ndarray:
    return np.full(FRAME, value, dtype=np.float32)


def make(**kwargs) -> Endpointer:
    defaults = dict(
        sample_rate=SAMPLE_RATE,
        frame_samples=FRAME,
        speech_threshold=0.5,
        silence_threshold_ms=500,
        max_utterance_seconds=12.0,
        min_utterance_ms=250,
        pre_roll_ms=300,
        post_roll_ms=200,
        speech_start_frames=2,
    )
    defaults.update(kwargs)
    return Endpointer(**defaults)


def drive(endpointer: Endpointer, pattern: list[tuple[float, int]]) -> list:
    """Feed (probability, frame count) pairs; collect emitted utterances."""
    out = []
    for probability, count in pattern:
        for _ in range(count):
            utterance = endpointer.push(probability, frame())
            if utterance is not None:
                out.append(utterance)
    return out


def test_silence_alone_emits_nothing():
    endpointer = make()
    assert drive(endpointer, [(0.0, 200)]) == []
    assert not endpointer.in_speech


def test_speech_then_silence_emits_one_utterance():
    endpointer = make()
    # 1 second of speech, then a full second of silence.
    utterances = drive(endpointer, [(0.0, 20), (0.9, 32), (0.0, 32)])
    assert len(utterances) == 1
    assert utterances[0].forced is False
    # 1s of speech, plus the configured 300ms pre-roll and 200ms post-roll.
    assert 1.0 <= utterances[0].duration <= 1.6


def test_endpoint_waits_for_the_full_silence_threshold():
    endpointer = make(silence_threshold_ms=500)
    # A 200ms pause mid-sentence must not split the utterance.
    utterances = drive(endpointer, [(0.9, 32), (0.0, 6), (0.9, 32)])
    assert utterances == []
    assert endpointer.in_speech


def test_pre_roll_is_included_so_onset_is_not_clipped():
    endpointer = make(pre_roll_ms=300, speech_start_frames=2)
    utterances = drive(endpointer, [(0.0, 40), (0.9, 32), (0.0, 32)])
    assert len(utterances) == 1
    # Speech began 300ms into the utterance's audio at the latest.
    assert utterances[0].start < 40 * FRAME_SECONDS
    expected_pre_roll = round(0.3 / FRAME_SECONDS) * FRAME
    assert utterances[0].samples() >= 32 * FRAME + expected_pre_roll * 0.8


def test_pre_roll_audio_is_not_duplicated():
    endpointer = make(pre_roll_ms=300, speech_start_frames=2, post_roll_ms=0)
    utterances = drive(endpointer, [(0.0, 40), (0.9, 32), (0.0, 32)])
    pre_roll_frames = round(0.3 / FRAME_SECONDS)
    # Exactly the full configured pre-roll plus the speech frames, with each
    # frame appearing once -- the ring must not double-count onset frames.
    assert utterances[0].samples() == (pre_roll_frames + 32) * FRAME


def test_long_monologue_flushes_at_max_length():
    endpointer = make(max_utterance_seconds=2.0)
    # 6 seconds of unbroken speech must produce interim text, not silence.
    utterances = drive(endpointer, [(0.9, 188)])
    assert len(utterances) >= 2
    assert all(u.forced for u in utterances)
    assert all(u.duration <= 2.0 + FRAME_SECONDS for u in utterances)


def test_forced_flush_keeps_timeline_continuous():
    endpointer = make(max_utterance_seconds=2.0)
    utterances = drive(endpointer, [(0.9, 188)])
    for earlier, later in zip(utterances, utterances[1:]):
        assert later.start == pytest.approx(earlier.end, abs=FRAME_SECONDS * 1.5)


def test_short_blip_is_discarded_as_too_short():
    endpointer = make(min_utterance_ms=250)
    # ~96ms of speech: below the floor, so it never reaches Whisper.
    utterances = drive(endpointer, [(0.9, 3), (0.0, 32)])
    assert utterances == []


def test_single_frame_noise_does_not_open_an_utterance():
    endpointer = make(speech_start_frames=2)
    drive(endpointer, [(0.9, 1), (0.0, 5)])
    assert not endpointer.in_speech


def test_trailing_silence_is_trimmed_to_the_post_roll():
    endpointer = make(post_roll_ms=200, silence_threshold_ms=500)
    utterances = drive(endpointer, [(0.9, 32), (0.0, 32)])
    post_roll_frames = round(0.2 / FRAME_SECONDS)
    speech_and_preroll = utterances[0].samples() - post_roll_frames * FRAME
    # Only the post-roll allowance of silence survives, not the full 500ms.
    assert speech_and_preroll <= 32 * FRAME + FRAME
    assert utterances[0].samples() > 32 * FRAME


def test_flush_closes_an_open_utterance_on_call_end():
    endpointer = make()
    drive(endpointer, [(0.9, 32)])
    assert endpointer.in_speech
    utterance = endpointer.flush()
    assert utterance is not None
    assert utterance.forced
    assert endpointer.flush() is None


def test_flush_discards_an_utterance_that_is_only_noise():
    endpointer = make(min_utterance_ms=250)
    drive(endpointer, [(0.9, 2)])
    assert endpointer.flush() is None


def test_reset_clears_all_state():
    endpointer = make()
    drive(endpointer, [(0.9, 32)])
    endpointer.reset()
    assert not endpointer.in_speech
    assert endpointer.elapsed_seconds == 0.0


def test_timestamps_track_position_in_the_call():
    endpointer = make(pre_roll_ms=0, speech_start_frames=1, post_roll_ms=0)
    # 10 seconds of silence, then speech.
    utterances = drive(endpointer, [(0.0, 313), (0.9, 32), (0.0, 32)])
    assert len(utterances) == 1
    assert utterances[0].start == pytest.approx(10.0, abs=0.1)
