"""Configuration loading for the transcription service.

Values come from config.yaml, with every key defaulted here so the service
starts on a machine that has never been configured. Phase 0's benchmark
(scripts/benchmark.py) picks `model`, `compute_type` and `beam_size`; the
rest are tuning knobs that rarely change.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, fields, is_dataclass
from pathlib import Path
from typing import Any

DEFAULT_CONFIG_PATH = Path(__file__).with_name("config.yaml")

# Domain vocabulary handed to Whisper as an initial_prompt (PR-6). Improves
# recognition of medtech and Jama-specific terms that PSTN audio mangles.
DEFAULT_INITIAL_PROMPT = (
    "Discussion of requirements management, traceability, IEC 62304, "
    "ISO 13485, FDA 510(k), design history file, DHF, verification and "
    "validation, Polarion, Codebeamer, Jama Connect, predicate device."
)


@dataclass
class VadConfig:
    enabled: bool = True
    speech_threshold: float = 0.5
    # How long a pause must run before an utterance is closed. Below ~800ms
    # this splits sentences at ordinary hesitations, and the back half then
    # reaches Whisper as a headless fragment: with condition_on_previous_text
    # off it has nothing to place the clause against, so it invents a
    # grammatical head instead of transcribing one. Holding on longer costs
    # latency and nothing else -- inference time does not scale with utterance
    # length -- so this is ~+380ms per utterance against the 2.5s p50 target
    # in scripts/benchmark.py, and fewer splits means fewer invocations.
    silence_threshold_ms: int = 900
    max_utterance_seconds: float = 12.0
    # Utterances shorter than this are discarded outright. Whisper reliably
    # hallucinates on sub-second fragments, so this is a correctness guard
    # rather than a performance one.
    min_utterance_ms: int = 250
    # Audio kept from just before speech onset, so the first phoneme is not
    # clipped by the VAD's attack delay.
    pre_roll_ms: int = 300
    # Trailing silence appended to an utterance. Whisper's endpointing is
    # more stable when a phrase does not end abruptly at the buffer edge.
    post_roll_ms: int = 200
    # Consecutive speech frames required to open an utterance; filters out
    # single-frame blips from line noise.
    speech_start_frames: int = 2


@dataclass
class TranscriptionConfig:
    model: str = "small.en"
    device: str = "cpu"
    compute_type: str = "int8"
    language: str = "en"
    beam_size: int = 1
    initial_prompt: str = DEFAULT_INITIAL_PROMPT
    # Whisper's own VAD is off: we gate upstream and hand it complete
    # utterances, so a second VAD pass would only trim what we already know.
    vad_filter: bool = False
    # The classic hallucination-loop amplifier. Leaving this on lets one
    # bad transcription poison every utterance that follows.
    condition_on_previous_text: bool = False
    max_queue_depth: int = 3
    # Cap on a coalesced utterance. Whisper pads to 30s regardless, so
    # merging up to ~25s costs the same as transcribing one short phrase.
    max_merge_seconds: float = 25.0
    # Silence inserted between merged utterances so Whisper still hears
    # phrase boundaries in the concatenation.
    merge_gap_ms: int = 200
    # Hallucination filters, applied per segment after inference.
    max_no_speech_prob: float = 0.6
    min_avg_logprob: float = -1.0
    max_compression_ratio: float = 2.4
    drop_blocklisted_short_segments: bool = True


@dataclass
class ServerConfig:
    host: str = "127.0.0.1"
    port: int = 8765
    # Prefix match against the WebSocket Origin header (PR-10). Extension
    # pages send chrome-extension://<id>; pin the full id here to lock the
    # service to one build.
    allowed_origins: list[str] = field(default_factory=lambda: ["chrome-extension://"])
    # The replay harness (scripts/replay_wav.py) sends no Origin header.
    allow_no_origin: bool = True
    # Run inference below normal priority so Whisper never competes with
    # Twilio's WebRTC encoder for CPU on a thermally limited laptop.
    lower_process_priority: bool = True


@dataclass
class StorageConfig:
    save_transcripts: bool = False
    transcript_dir: str = "~/Documents/salesloft-transcripts"
    # Present as an assertion, not a feature. Nothing in this service opens
    # a file for audio; main.py refuses to start if this is ever true.
    save_audio: bool = False


@dataclass
class Config:
    vad: VadConfig = field(default_factory=VadConfig)
    transcription: TranscriptionConfig = field(default_factory=TranscriptionConfig)
    server: ServerConfig = field(default_factory=ServerConfig)
    storage: StorageConfig = field(default_factory=StorageConfig)
    sample_rate: int = 16000
    # Silero VAD requires exactly 512 samples per call at 16kHz.
    frame_samples: int = 512

    @property
    def frame_ms(self) -> float:
        return 1000.0 * self.frame_samples / self.sample_rate


def _apply(target: Any, values: dict[str, Any], path: str = "") -> None:
    """Overlay a dict onto a dataclass, rejecting unknown keys loudly.

    A typo in config.yaml that silently kept a default would be very hard to
    notice from the outside -- the service would just behave as if the knob
    had never been turned.
    """
    known = {f.name: f for f in fields(target)}
    for key, value in values.items():
        if key not in known:
            raise ValueError(f"Unknown config key: {path}{key}")
        current = getattr(target, key)
        if is_dataclass(current) and isinstance(value, dict):
            _apply(current, value, f"{path}{key}.")
        else:
            setattr(target, key, value)


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    cfg = Config()
    config_path = Path(path) if path else DEFAULT_CONFIG_PATH
    if config_path.exists():
        import yaml

        with config_path.open("r", encoding="utf-8") as handle:
            raw = yaml.safe_load(handle) or {}
        if not isinstance(raw, dict):
            raise ValueError(f"{config_path} must contain a YAML mapping")
        _apply(cfg, raw)

    if cfg.storage.save_audio:
        raise ValueError(
            "storage.save_audio must remain false: this service has no code path "
            "that writes audio, and enabling the flag would misrepresent that."
        )
    return cfg
