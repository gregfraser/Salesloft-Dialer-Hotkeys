"""Voice-activity gating and utterance endpointing (PR-5).

The endpointing state machine is deliberately separated from the Silero model:
`Endpointer` consumes speech probabilities and knows nothing about ONNX, which
lets the whole gating policy be unit-tested without loading a model.

Why gate at all: Whisper pads every input to 30 seconds regardless of actual
length, so a 2-second slice costs roughly what a 25-second one does. Feeding it
complete utterances instead of fixed slices cuts invocation count by about an
order of magnitude and produces better text, because the model sees whole
phrases rather than words cut mid-syllable.
"""

from __future__ import annotations

from typing import Callable

import numpy as np

from audio import PreRollBuffer, Utterance


class Endpointer:
    """Accumulates speech frames and emits complete utterances.

    Feed it one (probability, frame) pair at a time; it returns an `Utterance`
    on the frame that closes one, and None otherwise.
    """

    def __init__(
        self,
        sample_rate: int = 16000,
        frame_samples: int = 512,
        speech_threshold: float = 0.5,
        silence_threshold_ms: int = 500,
        max_utterance_seconds: float = 12.0,
        min_utterance_ms: int = 250,
        pre_roll_ms: int = 300,
        post_roll_ms: int = 200,
        speech_start_frames: int = 2,
    ) -> None:
        self.sample_rate = sample_rate
        self.frame_samples = frame_samples
        self.speech_threshold = speech_threshold
        self.frame_seconds = frame_samples / sample_rate

        self.silence_frames_needed = max(1, round(silence_threshold_ms / 1000.0 / self.frame_seconds))
        self.max_utterance_frames = max(1, round(max_utterance_seconds / self.frame_seconds))
        self.min_speech_frames = max(1, round(min_utterance_ms / 1000.0 / self.frame_seconds))
        self.post_roll_frames = max(0, round(post_roll_ms / 1000.0 / self.frame_seconds))
        self.speech_start_frames = max(1, speech_start_frames)

        # The ring needs headroom for the frames that confirm speech onset:
        # those sit in the ring but belong to the utterance, so without the
        # extra slots the caller would silently get less pre-roll than asked.
        self.pre_roll_frames = max(0, round(pre_roll_ms / 1000.0 / self.frame_seconds))
        self._pre_roll = PreRollBuffer(
            self.pre_roll_frames + self.speech_start_frames if self.pre_roll_frames else 0
        )
        self._pending: list[np.ndarray] = []   # frames held before speech is confirmed
        self._active: list[np.ndarray] = []    # frames belonging to the open utterance
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0
        self._speech_frames = 0
        self._frames_seen = 0
        self._utterance_start_frame = 0

    # -- introspection, used by tests and the status endpoint -------------
    @property
    def in_speech(self) -> bool:
        return self._in_speech

    @property
    def elapsed_seconds(self) -> float:
        return self._frames_seen * self.frame_seconds

    def push(self, probability: float, frame: np.ndarray) -> Utterance | None:
        """Consume one frame. Returns a completed Utterance, or None."""
        is_speech = probability >= self.speech_threshold
        self._frames_seen += 1

        if not self._in_speech:
            self._pre_roll.push(frame)
            if is_speech:
                self._speech_run += 1
                self._pending.append(frame)
                if self._speech_run >= self.speech_start_frames:
                    self._open_utterance()
            else:
                # A run too short to count as speech onset; discard it and
                # let the pre-roll keep the audio in case speech follows.
                self._speech_run = 0
                self._pending.clear()
            return None

        self._active.append(frame)
        if is_speech:
            self._speech_frames += 1
            self._silence_run = 0
        else:
            self._silence_run += 1
            if self._silence_run >= self.silence_frames_needed:
                return self._close_utterance(forced=False)

        if len(self._active) >= self.max_utterance_frames:
            # Long monologue: flush what we have so text still appears
            # mid-sentence, and keep accumulating without a gap.
            return self._close_utterance(forced=True)
        return None

    def flush(self) -> Utterance | None:
        """Close any open utterance, e.g. on call end."""
        if not self._in_speech:
            return None
        return self._close_utterance(forced=True, ending=True)

    def reset(self) -> None:
        self._pre_roll.clear()
        self._pending.clear()
        self._active.clear()
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0
        self._speech_frames = 0
        self._frames_seen = 0
        self._utterance_start_frame = 0

    # -- internals --------------------------------------------------------
    def _open_utterance(self) -> None:
        pre = self._pre_roll.drain()
        # The pending frames are already in the pre-roll ring; keep only the
        # portion of the ring that precedes them to avoid duplicating audio.
        if self._pending:
            pre = pre[: max(0, len(pre) - len(self._pending))]
        self._active = pre + self._pending
        self._utterance_start_frame = self._frames_seen - len(self._active)
        self._in_speech = True
        self._speech_frames = len(self._pending)
        self._silence_run = 0
        self._pending = []

    def _close_utterance(self, forced: bool, ending: bool = False) -> Utterance | None:
        frames = self._active
        speech_frames = self._speech_frames
        start_frame = self._utterance_start_frame

        # Trim silence beyond the post-roll allowance so Whisper is not handed
        # half a second of dead air on every phrase.
        if not forced and self._silence_run > self.post_roll_frames:
            frames = frames[: len(frames) - (self._silence_run - self.post_roll_frames)]

        self._active = []
        self._in_speech = False
        self._speech_run = 0
        self._silence_run = 0
        self._speech_frames = 0
        self._pre_roll.clear()

        if forced and not ending:
            # A max-length flush continues the same stretch of speech: reopen
            # immediately so the next frame does not need a fresh onset.
            self._in_speech = True
            self._utterance_start_frame = self._frames_seen

        if speech_frames < self.min_speech_frames or not frames:
            # Too short to be real speech. Whisper hallucinates confidently on
            # fragments like this, so it never reaches inference.
            return None

        audio = np.concatenate(frames) if len(frames) > 1 else frames[0].copy()
        return Utterance(
            audio=audio.astype(np.float32, copy=False),
            start=start_frame * self.frame_seconds,
            end=(start_frame + len(frames)) * self.frame_seconds,
            forced=forced,
        )


class SileroVAD:
    """Thin wrapper over Silero VAD.

    Imported lazily so the endpointing logic (and its tests) do not require
    onnxruntime or torch to be installed.
    """

    def __init__(self, sample_rate: int = 16000, use_onnx: bool = True) -> None:
        self.sample_rate = sample_rate
        self.use_onnx = use_onnx
        self._model = None

    def load(self) -> None:
        if self._model is not None:
            return
        from silero_vad import load_silero_vad

        self._model = load_silero_vad(onnx=self.use_onnx)

    def reset(self) -> None:
        if self._model is not None and hasattr(self._model, "reset_states"):
            self._model.reset_states()

    def probability(self, frame: np.ndarray) -> float:
        if self._model is None:
            self.load()
        import torch

        with torch.no_grad():
            return float(self._model(torch.from_numpy(frame), self.sample_rate).item())


def always_speech(_frame: np.ndarray) -> float:
    """Probability function used when VAD is disabled -- everything is speech.

    Kept so the pipeline shape is identical with gating off, which matters for
    A/B benchmarking the gating strategy itself.
    """
    return 1.0


ProbabilityFn = Callable[[np.ndarray], float]
