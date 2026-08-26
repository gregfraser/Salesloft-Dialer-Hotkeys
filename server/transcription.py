"""faster-whisper wrapper, backpressure queue and output filtering (PR-6).

Three things live here, in increasing order of how much they depend on the
model being installed:

* `UtteranceQueue` -- backpressure policy. Pure, no model.
* `classify_segment` -- hallucination filtering. Pure, no model.
* `WhisperTranscriber` / `TranscriptionWorker` -- the model itself, imported
  lazily so the two above can be tested on a machine with no CTranslate2.
"""

from __future__ import annotations

import logging
import time
from bisect import insort
from collections import deque
from dataclasses import dataclass, field

import numpy as np

from audio import Utterance, silence

log = logging.getLogger(__name__)


# ---------------------------------------------------------------- backpressure
@dataclass
class QueueStats:
    """What a single put() did to relieve pressure."""

    merged: int = 0
    dropped: int = 0

    @property
    def degraded(self) -> bool:
        return bool(self.merged or self.dropped)


class UtteranceQueue:
    """Bounded queue that coalesces under pressure instead of discarding.

    Whisper pads every input to 30 seconds, so transcribing three queued
    utterances as one concatenation costs about what transcribing the shortest
    of them alone would. Merging therefore recovers all the speech that a
    drop-oldest policy would have thrown away, at no extra inference cost.
    Dropping remains as a last resort for when a merge would exceed the
    model's window.
    """

    def __init__(
        self,
        max_depth: int = 3,
        max_merge_seconds: float = 25.0,
        merge_gap_ms: int = 200,
        sample_rate: int = 16000,
    ) -> None:
        self.max_depth = max(1, max_depth)
        self.max_merge_seconds = max_merge_seconds
        self.merge_gap_ms = merge_gap_ms
        self.sample_rate = sample_rate
        self._items: deque[Utterance] = deque()

    def __len__(self) -> int:
        return len(self._items)

    def audio_seconds(self, utterance: Utterance) -> float:
        return utterance.audio.size / float(self.sample_rate)

    def put(self, utterance: Utterance) -> QueueStats:
        self._items.append(utterance)
        stats = QueueStats()
        while len(self._items) > self.max_depth:
            if not self._merge_oldest_pair(stats):
                self._items.popleft()
                stats.dropped += 1
        return stats

    def get(self) -> Utterance | None:
        return self._items.popleft() if self._items else None

    def clear(self) -> None:
        self._items.clear()

    def _merge_oldest_pair(self, stats: QueueStats) -> bool:
        if len(self._items) < 2:
            return False
        first, second = self._items[0], self._items[1]
        gap = silence(self.merge_gap_ms, self.sample_rate)
        total = (first.audio.size + gap.size + second.audio.size) / float(self.sample_rate)
        if total > self.max_merge_seconds:
            return False

        merged = Utterance(
            audio=np.concatenate([first.audio, gap, second.audio]),
            start=first.start,
            end=second.end,
            forced=first.forced or second.forced,
            merged=first.merged + second.merged,
            # The oldest utterance sets the clock: merging must not make the
            # reported latency look better than what the rep actually waited.
            enqueued_at=min(first.enqueued_at, second.enqueued_at) or first.enqueued_at,
        )
        self._items.popleft()
        self._items.popleft()
        self._items.appendleft(merged)
        stats.merged += 1
        return True


# ------------------------------------------------------------------ filtering
# Phrases Whisper emits when handed silence, hold music, or line noise. Matched
# only against short segments -- a prospect really can say "thank you".
HALLUCINATION_PHRASES = frozenset(
    {
        "thank you",
        "thank you.",
        "thanks for watching",
        "thanks for watching!",
        "thank you for watching",
        "please subscribe",
        "subscribe to my channel",
        "you",
        "bye",
        "bye.",
        "okay",
        ".",
        "..",
        "...",
    }
)

HALLUCINATION_SHORT_SEGMENT_SECONDS = 1.5


def normalize_text(text: str) -> str:
    return " ".join(text.lower().split()).strip()


def classify_segment(
    text: str,
    *,
    duration: float,
    no_speech_prob: float = 0.0,
    avg_logprob: float = 0.0,
    compression_ratio: float = 1.0,
    max_no_speech_prob: float = 0.6,
    min_avg_logprob: float = -1.0,
    max_compression_ratio: float = 2.4,
    drop_blocklisted_short_segments: bool = True,
) -> str | None:
    """Return a rejection reason, or None if the segment should be shown.

    Mid-call, a hallucinated line is worse than no line at all: a rep who reads
    back something the prospect never said loses the deal and their trust in
    the tool at the same time. These thresholds bias hard toward dropping.
    """
    stripped = normalize_text(text)
    if not stripped:
        return "empty"
    if no_speech_prob > max_no_speech_prob:
        return f"no_speech_prob={no_speech_prob:.2f}"
    if avg_logprob < min_avg_logprob:
        return f"avg_logprob={avg_logprob:.2f}"
    if compression_ratio > max_compression_ratio:
        # Runaway repetition ("yeah yeah yeah yeah..."), Whisper's other
        # characteristic failure on degraded audio.
        return f"compression_ratio={compression_ratio:.2f}"
    if (
        drop_blocklisted_short_segments
        and duration <= HALLUCINATION_SHORT_SEGMENT_SECONDS
        and stripped in HALLUCINATION_PHRASES
    ):
        return "blocklisted_phrase"
    return None


# -------------------------------------------------------------------- metrics
class LatencyTracker:
    """Rolling latency percentiles, plus the drift comparison from §9.

    Drift is the metric that decides whether the design works: a steady 4s lag
    is usable, a 2s lag that grows to 30s over a call is not.
    """

    def __init__(self, drift_window_seconds: float = 120.0) -> None:
        self.drift_window_seconds = drift_window_seconds
        self._samples: list[tuple[float, float]] = []  # (call elapsed s, latency s)
        self._sorted: list[float] = []

    def record(self, call_elapsed: float, latency: float) -> None:
        self._samples.append((call_elapsed, latency))
        insort(self._sorted, latency)

    @property
    def count(self) -> int:
        return len(self._samples)

    def percentile(self, pct: float) -> float:
        if not self._sorted:
            return 0.0
        index = min(len(self._sorted) - 1, max(0, int(round(pct / 100.0 * (len(self._sorted) - 1)))))
        return self._sorted[index]

    @staticmethod
    def _p95(values: list[float]) -> float:
        if not values:
            return 0.0
        ordered = sorted(values)
        index = min(len(ordered) - 1, max(0, int(round(0.95 * (len(ordered) - 1)))))
        return ordered[index]

    def drift(self) -> float | None:
        """P95 growth between the first and last window of the call."""
        if not self._samples:
            return None
        last_elapsed = self._samples[-1][0]
        if last_elapsed < 2 * self.drift_window_seconds:
            return None
        head = [lat for elapsed, lat in self._samples if elapsed <= self.drift_window_seconds]
        tail = [lat for elapsed, lat in self._samples if elapsed >= last_elapsed - self.drift_window_seconds]
        if not head or not tail:
            return None
        return self._p95(tail) - self._p95(head)

    def summary(self) -> dict:
        return {
            "count": self.count,
            "p50_seconds": round(self.percentile(50), 3),
            "p95_seconds": round(self.percentile(95), 3),
            "max_seconds": round(self._sorted[-1], 3) if self._sorted else 0.0,
            "drift_seconds": (round(self.drift(), 3) if self.drift() is not None else None),
        }


# --------------------------------------------------------------------- engine
@dataclass
class TranscriptSegment:
    text: str
    start: float
    end: float
    no_speech_prob: float = 0.0
    avg_logprob: float = 0.0
    compression_ratio: float = 1.0


@dataclass
class TranscriptionResult:
    segments: list[TranscriptSegment] = field(default_factory=list)
    rejected: list[str] = field(default_factory=list)
    inference_seconds: float = 0.0


class WhisperTranscriber:
    """faster-whisper, loaded once and driven one utterance at a time."""

    def __init__(self, cfg) -> None:
        self.cfg = cfg
        self._model = None

    @property
    def loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        if self._model is not None:
            return
        from faster_whisper import WhisperModel

        log.info(
            "Loading faster-whisper model=%s device=%s compute_type=%s",
            self.cfg.model,
            self.cfg.device,
            self.cfg.compute_type,
        )
        started = time.monotonic()
        self._model = WhisperModel(
            self.cfg.model,
            device=self.cfg.device,
            compute_type=self.cfg.compute_type,
        )
        log.info("Model loaded in %.1fs", time.monotonic() - started)

    def transcribe(self, audio: np.ndarray) -> TranscriptionResult:
        if self._model is None:
            self.load()

        started = time.monotonic()
        segments, _info = self._model.transcribe(
            audio,
            language=self.cfg.language,
            beam_size=self.cfg.beam_size,
            initial_prompt=self.cfg.initial_prompt,
            vad_filter=self.cfg.vad_filter,
            condition_on_previous_text=self.cfg.condition_on_previous_text,
        )

        result = TranscriptionResult()
        for segment in segments:
            reason = classify_segment(
                segment.text,
                duration=max(0.0, segment.end - segment.start),
                no_speech_prob=getattr(segment, "no_speech_prob", 0.0),
                avg_logprob=getattr(segment, "avg_logprob", 0.0),
                compression_ratio=getattr(segment, "compression_ratio", 1.0),
                max_no_speech_prob=self.cfg.max_no_speech_prob,
                min_avg_logprob=self.cfg.min_avg_logprob,
                max_compression_ratio=self.cfg.max_compression_ratio,
                drop_blocklisted_short_segments=self.cfg.drop_blocklisted_short_segments,
            )
            if reason:
                result.rejected.append(f"{segment.text.strip()!r}: {reason}")
                continue
            result.segments.append(
                TranscriptSegment(
                    text=segment.text.strip(),
                    start=segment.start,
                    end=segment.end,
                    no_speech_prob=getattr(segment, "no_speech_prob", 0.0),
                    avg_logprob=getattr(segment, "avg_logprob", 0.0),
                    compression_ratio=getattr(segment, "compression_ratio", 1.0),
                )
            )
        result.inference_seconds = time.monotonic() - started
        return result
