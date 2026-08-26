"""Backpressure, hallucination filtering and latency metrics (PR-6, §9).

None of this touches faster-whisper, so it runs without CTranslate2 installed.
"""

import numpy as np
import pytest

from audio import Utterance
from transcription import (
    LatencyTracker,
    UtteranceQueue,
    classify_segment,
    normalize_text,
)

SAMPLE_RATE = 16000


def utterance(seconds: float, start: float = 0.0, value: float = 0.5) -> Utterance:
    samples = int(seconds * SAMPLE_RATE)
    return Utterance(
        audio=np.full(samples, value, dtype=np.float32),
        start=start,
        end=start + seconds,
    )


# ------------------------------------------------------------------ the queue
def test_queue_below_depth_is_untouched():
    queue = UtteranceQueue(max_depth=3)
    for i in range(3):
        stats = queue.put(utterance(2.0, start=i * 2.0))
        assert not stats.degraded
    assert len(queue) == 3


def test_overflow_merges_instead_of_dropping():
    queue = UtteranceQueue(max_depth=3, max_merge_seconds=25.0)
    for i in range(4):
        stats = queue.put(utterance(2.0, start=i * 2.0))
    assert stats.merged == 1
    assert stats.dropped == 0
    assert len(queue) == 3

    merged = queue.get()
    assert merged.merged == 2
    # Both utterances' audio survives, plus the inserted gap.
    expected = int(2.0 * SAMPLE_RATE) * 2 + int(0.2 * SAMPLE_RATE)
    assert merged.samples() == expected


def test_merged_utterance_spans_both_timestamps():
    queue = UtteranceQueue(max_depth=1)
    queue.put(utterance(2.0, start=10.0))
    queue.put(utterance(2.0, start=20.0))
    merged = queue.get()
    assert merged.start == 10.0
    assert merged.end == 22.0


def test_merge_inserts_silence_between_utterances():
    queue = UtteranceQueue(max_depth=1, merge_gap_ms=200)
    queue.put(utterance(1.0, value=0.5))
    queue.put(utterance(1.0, value=0.5))
    merged = queue.get()
    gap = merged.audio[int(1.0 * SAMPLE_RATE) : int(1.2 * SAMPLE_RATE)]
    assert np.allclose(gap, 0.0)


def test_drop_is_the_last_resort_when_a_merge_would_exceed_the_window():
    # Two 2s utterances cannot merge under a 3s cap, so the oldest goes.
    queue = UtteranceQueue(max_depth=1, max_merge_seconds=3.0)
    queue.put(utterance(2.0, start=0.0))
    stats = queue.put(utterance(2.0, start=2.0))
    assert stats.dropped == 1
    assert stats.merged == 0
    assert len(queue) == 1
    assert queue.get().start == 2.0


def test_merging_respects_the_whisper_window():
    queue = UtteranceQueue(max_depth=1, max_merge_seconds=25.0)
    queue.put(utterance(20.0, start=0.0))
    queue.put(utterance(20.0, start=20.0))
    # 40s of audio cannot be one invocation, so the oldest is dropped.
    assert len(queue) == 1
    assert queue.get().samples() == int(20.0 * SAMPLE_RATE)


def test_fifo_order_is_preserved():
    queue = UtteranceQueue(max_depth=5)
    for i in range(4):
        queue.put(utterance(1.0, start=float(i)))
    assert [queue.get().start for _ in range(4)] == [0.0, 1.0, 2.0, 3.0]


def test_get_on_empty_queue_returns_none():
    assert UtteranceQueue().get() is None


# --------------------------------------------------------------- the filtering
def test_normal_speech_passes():
    assert classify_segment("We're currently using Polarion.", duration=2.5) is None


def test_empty_text_is_rejected():
    assert classify_segment("   ", duration=2.0) == "empty"


def test_high_no_speech_probability_is_rejected():
    reason = classify_segment("Thanks for watching!", duration=2.0, no_speech_prob=0.9)
    assert reason and reason.startswith("no_speech_prob")


def test_low_confidence_is_rejected():
    reason = classify_segment("mumble mumble", duration=2.0, avg_logprob=-2.0)
    assert reason and reason.startswith("avg_logprob")


def test_runaway_repetition_is_rejected():
    reason = classify_segment("yeah yeah yeah yeah", duration=3.0, compression_ratio=5.0)
    assert reason and reason.startswith("compression_ratio")


def test_blocklisted_phrase_is_rejected_when_short():
    assert classify_segment("Thanks for watching", duration=0.8) == "blocklisted_phrase"


def test_blocklisted_phrase_survives_when_the_segment_is_long():
    # A real prospect saying "thank you" over 3 seconds is not a hallucination.
    assert classify_segment("Thank you.", duration=3.0) is None


def test_blocklist_can_be_disabled():
    assert (
        classify_segment(
            "Thank you.", duration=0.5, drop_blocklisted_short_segments=False
        )
        is None
    )


def test_normalize_text_collapses_whitespace_and_case():
    assert normalize_text("  Thank   YOU.  ") == "thank you."


# ----------------------------------------------------------------- the metrics
def test_percentiles_track_recorded_latencies():
    tracker = LatencyTracker()
    for i in range(100):
        tracker.record(call_elapsed=float(i), latency=i / 100.0)
    assert tracker.count == 100
    assert tracker.percentile(50) == pytest.approx(0.5, abs=0.02)
    assert tracker.percentile(95) == pytest.approx(0.95, abs=0.02)


def test_drift_needs_a_long_enough_call():
    tracker = LatencyTracker(drift_window_seconds=120.0)
    tracker.record(10.0, 1.0)
    assert tracker.drift() is None


def test_drift_detects_latency_growth_across_a_call():
    tracker = LatencyTracker(drift_window_seconds=120.0)
    for i in range(60):           # first 2 minutes, steady 2s
        tracker.record(float(i * 2), 2.0)
    for i in range(60):           # last 2 minutes of a 10 minute call, 8s
        tracker.record(480.0 + i * 2, 8.0)
    assert tracker.drift() == pytest.approx(6.0, abs=0.1)


def test_a_steady_system_reports_no_drift():
    tracker = LatencyTracker(drift_window_seconds=120.0)
    for i in range(300):
        tracker.record(float(i * 2), 3.0)
    assert tracker.drift() == pytest.approx(0.0, abs=0.01)


def test_summary_is_json_serializable():
    import json

    tracker = LatencyTracker()
    tracker.record(1.0, 2.0)
    assert json.loads(json.dumps(tracker.summary()))["count"] == 1
