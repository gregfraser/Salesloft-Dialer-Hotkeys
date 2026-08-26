"""PCM buffering and conversion.

Everything here operates on in-memory numpy arrays. No function in this
module opens a file -- see docs/compliance.md for why that is a design
constraint rather than an oversight.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

INT16_SCALE = 32768.0


def pcm16_to_float32(data: bytes | np.ndarray) -> np.ndarray:
    """Convert little-endian Int16 PCM to the Float32 range Whisper expects."""
    if isinstance(data, bytes):
        if len(data) % 2:
            # A partial sample means a frame boundary landed mid-value; drop
            # the stray byte rather than shifting every sample after it.
            data = data[:-1]
        samples = np.frombuffer(data, dtype="<i2")
    else:
        samples = data.astype("<i2", copy=False)
    return (samples.astype(np.float32) / INT16_SCALE).copy()


def float32_to_pcm16(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    return (clipped * (INT16_SCALE - 1)).astype("<i2").tobytes()


def silence(duration_ms: int, sample_rate: int = 16000) -> np.ndarray:
    return np.zeros(int(sample_rate * duration_ms / 1000.0), dtype=np.float32)


class FrameSplitter:
    """Re-chunk an arbitrary byte stream into fixed-size sample frames.

    WebSocket frames arrive at whatever size the AudioWorklet posted, but
    Silero VAD requires exactly 512 samples per call at 16kHz. This holds the
    remainder between pushes.
    """

    def __init__(self, frame_samples: int = 512) -> None:
        self.frame_samples = frame_samples
        self._tail = np.empty(0, dtype=np.float32)

    def push(self, data: bytes | np.ndarray) -> list[np.ndarray]:
        samples = pcm16_to_float32(data) if isinstance(data, bytes) else data
        if self._tail.size:
            samples = np.concatenate([self._tail, samples])
        count = samples.size // self.frame_samples
        frames = [
            samples[i * self.frame_samples : (i + 1) * self.frame_samples]
            for i in range(count)
        ]
        self._tail = samples[count * self.frame_samples :].copy()
        return frames

    def reset(self) -> None:
        self._tail = np.empty(0, dtype=np.float32)


class PreRollBuffer:
    """Fixed-length ring of recent frames, kept so an utterance can include
    the audio immediately before the VAD noticed speech."""

    def __init__(self, max_frames: int) -> None:
        self.max_frames = max(0, max_frames)
        self._frames: deque[np.ndarray] = deque(maxlen=self.max_frames or 1)

    def push(self, frame: np.ndarray) -> None:
        if self.max_frames:
            self._frames.append(frame)

    def drain(self) -> list[np.ndarray]:
        frames = list(self._frames)
        self._frames.clear()
        return frames

    def clear(self) -> None:
        self._frames.clear()

    def __len__(self) -> int:
        return len(self._frames)


@dataclass
class Utterance:
    """A complete unit of speech, ready for a single Whisper invocation."""

    audio: np.ndarray
    start: float           # seconds since call start
    end: float             # seconds since call start
    forced: bool = False   # flushed at max length rather than at a real endpoint
    merged: int = 1        # how many utterances were coalesced into this one
    # Wall clock at the moment the endpoint was detected. Latency in §9 is
    # measured from here to the transcript reaching the panel.
    enqueued_at: float = 0.0

    @property
    def duration(self) -> float:
        return self.end - self.start

    def samples(self) -> int:
        return int(self.audio.size)
