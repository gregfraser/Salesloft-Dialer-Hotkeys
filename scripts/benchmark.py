#!/usr/bin/env python3
"""Phase 0 feasibility benchmark.

Benchmarks the STREAMING pattern, not file transcription. A whole-file
real-time factor is misleading here: Whisper pads every input to 30 seconds, so
what matters is how the model behaves on the actual workload -- a sequence of
VAD-gated utterances arriving as the prospect speaks.

Latency is modelled rather than waited out. Inference is serialized, so given
each utterance's audio end time t_i and its measured inference time d_i:

    start_i  = max(t_i, finish_{i-1})      # queued behind the previous one
    finish_i = start_i + d_i
    latency_i = finish_i - t_i             # what the rep actually waits

That is exact for a single-worker queue and lets the whole matrix run at full
speed instead of in real time, while still exposing cumulative drift -- the
metric that separates a design that works from one that merely demos well.

Usage:
    python scripts/benchmark.py sample1.wav sample2.wav
    python scripts/benchmark.py --models base.en,small.en --reference ref.txt sample.wav
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "server"))

from config import DEFAULT_INITIAL_PROMPT, VadConfig  # noqa: E402
from transcription import classify_segment  # noqa: E402
from vad import Endpointer, SileroVAD  # noqa: E402

TARGET_RATE = 16000

# §9 targets. A configuration must clear all of these to be recommended.
TARGET_P50 = 2.5
TARGET_P95 = 5.0
TARGET_DRIFT = 2.0


# ------------------------------------------------------------------ audio I/O
def _design_low_pass(length: int, normalized_cutoff: float) -> np.ndarray:
    middle = (length - 1) / 2
    n = np.arange(length) - middle
    with np.errstate(invalid="ignore", divide="ignore"):
        sinc = np.where(
            n == 0,
            2 * normalized_cutoff,
            np.sin(2 * np.pi * normalized_cutoff * n) / (np.pi * n),
        )
    window = np.blackman(length)
    taps = sinc * window
    return taps / taps.sum()


def load_wav_16k(path: Path) -> np.ndarray:
    """Read a WAV as 16kHz mono float32, anti-aliasing on the way down."""
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())

    if width != 2:
        raise ValueError(f"{path.name}: expected 16-bit PCM, got {width * 8}-bit")

    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)

    if rate != TARGET_RATE:
        if rate > TARGET_RATE:
            cutoff = min(0.45 * TARGET_RATE, 7600) / rate
            samples = np.convolve(samples, _design_low_pass(63, cutoff), mode="same")
        positions = np.arange(0, len(samples), rate / TARGET_RATE)
        positions = positions[positions < len(samples) - 1]
        samples = np.interp(positions, np.arange(len(samples)), samples).astype(np.float32)

    return samples.astype(np.float32)


# --------------------------------------------------------------------- scoring
def word_error_rate(reference: str, hypothesis: str) -> float:
    """Levenshtein distance over words, normalised by reference length."""
    ref = reference.lower().split()
    hyp = hypothesis.lower().split()
    if not ref:
        return 0.0
    previous = list(range(len(hyp) + 1))
    for i, ref_word in enumerate(ref, start=1):
        current = [i]
        for j, hyp_word in enumerate(hyp, start=1):
            current.append(
                min(
                    previous[j] + 1,                                   # deletion
                    current[j - 1] + 1,                                # insertion
                    previous[j - 1] + (ref_word != hyp_word),          # substitution
                )
            )
        previous = current
    return previous[-1] / len(ref)


def proper_noun_recall(terms: list[str], hypothesis: str) -> float | None:
    """Fraction of domain terms that survived transcription.

    Overall WER hides the failure that matters: narrowband audio mangles proper
    nouns, acronyms and numbers first, and those are exactly what makes a
    read-back useful. A config with good WER and bad recall here is not usable
    for UC-1.
    """
    if not terms:
        return None
    text = hypothesis.lower()
    return sum(1 for term in terms if term.lower() in text) / len(terms)


# ------------------------------------------------------------------ the runner
@dataclass
class Result:
    model: str
    compute_type: str
    beam_size: int
    utterances: int = 0
    audio_seconds: float = 0.0
    inference_seconds: float = 0.0
    latencies: list[float] = field(default_factory=list)
    drift: float = 0.0
    rejected: int = 0
    peak_rss_mb: float = 0.0
    load_seconds: float = 0.0
    text: str = ""
    error: str | None = None

    @property
    def rtf(self) -> float:
        return self.inference_seconds / self.audio_seconds if self.audio_seconds else 0.0

    @property
    def p50(self) -> float:
        return statistics.median(self.latencies) if self.latencies else 0.0

    @property
    def p95(self) -> float:
        if not self.latencies:
            return 0.0
        ordered = sorted(self.latencies)
        return ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]

    def meets_targets(self) -> bool:
        return (
            not self.error
            and self.p50 < TARGET_P50
            and self.p95 < TARGET_P95
            and self.drift < TARGET_DRIFT
        )


def segment_utterances(samples: np.ndarray, vad: SileroVAD, vad_cfg: VadConfig, frame_samples: int):
    """Run the same gating the live service uses, so the benchmark measures the
    real workload rather than an idealised one."""
    endpointer = Endpointer(
        sample_rate=TARGET_RATE,
        frame_samples=frame_samples,
        speech_threshold=vad_cfg.speech_threshold,
        silence_threshold_ms=vad_cfg.silence_threshold_ms,
        max_utterance_seconds=vad_cfg.max_utterance_seconds,
        min_utterance_ms=vad_cfg.min_utterance_ms,
        pre_roll_ms=vad_cfg.pre_roll_ms,
        post_roll_ms=vad_cfg.post_roll_ms,
        speech_start_frames=vad_cfg.speech_start_frames,
    )
    utterances = []
    total = len(samples) // frame_samples
    for i in range(total):
        frame = samples[i * frame_samples : (i + 1) * frame_samples]
        utterance = endpointer.push(vad.probability(frame), frame)
        if utterance is not None:
            utterances.append(utterance)
    trailing = endpointer.flush()
    if trailing is not None:
        utterances.append(trailing)
    return utterances


def peak_rss_mb() -> float:
    try:
        import psutil

        return psutil.Process().memory_info().rss / (1024 * 1024)
    except Exception:  # noqa: BLE001
        return 0.0


def run_config(
    model_name: str,
    compute_type: str,
    beam_size: int,
    utterance_sets: list[list],
    reference: str | None,
    terms: list[str],
) -> Result:
    from faster_whisper import WhisperModel

    result = Result(model=model_name, compute_type=compute_type, beam_size=beam_size)
    try:
        started = time.monotonic()
        model = WhisperModel(model_name, device="cpu", compute_type=compute_type)
        result.load_seconds = time.monotonic() - started
    except Exception as exc:  # noqa: BLE001
        result.error = f"load failed: {exc}"
        return result

    pieces: list[str] = []
    for utterances in utterance_sets:
        finish = 0.0
        for utterance in utterances:
            begin = time.monotonic()
            segments, _info = model.transcribe(
                utterance.audio,
                language="en",
                beam_size=beam_size,
                initial_prompt=DEFAULT_INITIAL_PROMPT,
                vad_filter=False,
                condition_on_previous_text=False,
            )
            kept = []
            for segment in segments:
                reason = classify_segment(
                    segment.text,
                    duration=max(0.0, segment.end - segment.start),
                    no_speech_prob=getattr(segment, "no_speech_prob", 0.0),
                    avg_logprob=getattr(segment, "avg_logprob", 0.0),
                    compression_ratio=getattr(segment, "compression_ratio", 1.0),
                )
                if reason:
                    result.rejected += 1
                else:
                    kept.append(segment.text.strip())
            elapsed = time.monotonic() - begin

            # Single-worker queue model: an utterance cannot start before the
            # previous one finished, which is where drift comes from.
            start = max(utterance.end, finish)
            finish = start + elapsed
            result.latencies.append(finish - utterance.end)

            result.utterances += 1
            result.inference_seconds += elapsed
            result.audio_seconds += utterance.duration
            pieces.extend(kept)

        # Each sample file is its own call: the queue starts empty.
        finish = 0.0

    result.text = " ".join(pieces)
    result.peak_rss_mb = peak_rss_mb()

    # Drift: P95 over the first quarter of utterances versus the last quarter.
    if len(result.latencies) >= 8:
        quarter = max(2, len(result.latencies) // 4)
        head = sorted(result.latencies[:quarter])
        tail = sorted(result.latencies[-quarter:])
        pick = lambda xs: xs[min(len(xs) - 1, int(round(0.95 * (len(xs) - 1))))]  # noqa: E731
        result.drift = max(0.0, pick(tail) - pick(head))

    del model
    return result


# ---------------------------------------------------------------------- output
def render_table(results: list[Result], reference: str | None, terms: list[str]) -> str:
    header = (
        "| Model | Compute | Beam | Utts | RTF | P50 | P95 | Drift | Rejected | RAM MB |"
    )
    if reference:
        header += " WER |"
    if terms:
        header += " Term recall |"
    lines = [header, "|" + "---|" * (header.count("|") - 1)]

    for result in results:
        if result.error:
            lines.append(f"| {result.model} | {result.compute_type} | {result.beam_size} | — | — | — | — | — | — | — | {result.error} |")
            continue
        row = (
            f"| {result.model} | {result.compute_type} | {result.beam_size} "
            f"| {result.utterances} | {result.rtf:.2f} | {result.p50:.2f}s | {result.p95:.2f}s "
            f"| {result.drift:.2f}s | {result.rejected} | {result.peak_rss_mb:.0f} |"
        )
        if reference:
            row += f" {word_error_rate(reference, result.text):.1%} |"
        if terms:
            recall = proper_noun_recall(terms, result.text)
            row += f" {recall:.0%} |" if recall is not None else " — |"
        lines.append(row)
    return "\n".join(lines)


def recommend(results: list[Result], reference: str | None) -> str:
    viable = [r for r in results if r.meets_targets()]
    if not viable:
        return (
            "NO-GO: no configuration met the §9 targets "
            f"(P50 < {TARGET_P50}s, P95 < {TARGET_P95}s, drift < {TARGET_DRIFT}s).\n"
            "Take an escape hatch from §7.3 before abandoning local inference:\n"
            "  * whisper_streaming (UFAL) LocalAgreement-2 over faster-whisper\n"
            "  * Moonshine -- streaming-native, no 30s padding\n"
            "  * sherpa-onnx streaming Zipformer\n"
            "  * downgrade to distil-small.en or base.en\n"
            "  * near-real-time fallback: 15s batches, keeps UC-2 through UC-4"
        )

    if reference:
        best = min(viable, key=lambda r: word_error_rate(reference, r.text))
    else:
        best = min(viable, key=lambda r: r.p95)

    return (
        f"GO: {best.model} / {best.compute_type} / beam_size={best.beam_size}\n"
        f"  P50 {best.p50:.2f}s, P95 {best.p95:.2f}s, drift {best.drift:.2f}s, RTF {best.rtf:.2f}\n"
        f"  Put this in server/config.yaml under `transcription`."
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("samples", nargs="+", type=Path, help="WAV files of real recorded call audio")
    parser.add_argument("--models", default="base.en,small.en,distil-small.en")
    parser.add_argument("--compute-types", default="int8,int8_float32")
    parser.add_argument("--beam-sizes", default="1,3")
    parser.add_argument("--reference", type=Path, help="hand-corrected transcript, for WER")
    parser.add_argument(
        "--terms",
        type=Path,
        help="newline-separated domain terms (tool names, standards) for recall scoring",
    )
    parser.add_argument("--json", type=Path, help="also write raw results here")
    args = parser.parse_args()

    for sample in args.samples:
        if not sample.exists():
            print(f"error: {sample} not found", file=sys.stderr)
            return 2

    print("Loading Silero VAD…")
    vad = SileroVAD(sample_rate=TARGET_RATE)
    vad.load()
    vad_cfg = VadConfig()

    utterance_sets = []
    total_audio = 0.0
    for sample in args.samples:
        samples = load_wav_16k(sample)
        total_audio += len(samples) / TARGET_RATE
        vad.reset()
        utterances = segment_utterances(samples, vad, vad_cfg, 512)
        speech = sum(u.duration for u in utterances)
        print(
            f"  {sample.name}: {len(samples) / TARGET_RATE:.0f}s audio -> "
            f"{len(utterances)} utterances ({speech:.0f}s speech)"
        )
        utterance_sets.append(utterances)

    if not any(utterance_sets):
        print("error: VAD found no speech in the samples", file=sys.stderr)
        return 2

    reference = args.reference.read_text(encoding="utf-8") if args.reference else None
    terms = (
        [line.strip() for line in args.terms.read_text(encoding="utf-8").splitlines() if line.strip()]
        if args.terms
        else []
    )

    results: list[Result] = []
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    computes = [c.strip() for c in args.compute_types.split(",") if c.strip()]
    beams = [int(b) for b in args.beam_sizes.split(",") if b.strip()]

    total_configs = len(models) * len(computes) * len(beams)
    index = 0
    for model_name in models:
        for compute_type in computes:
            for beam_size in beams:
                index += 1
                print(f"[{index}/{total_configs}] {model_name} / {compute_type} / beam {beam_size}…", flush=True)
                results.append(
                    run_config(model_name, compute_type, beam_size, utterance_sets, reference, terms)
                )

    print("\n" + render_table(results, reference, terms))
    print("\n" + recommend(results, reference))
    print(
        "\nNote: CPU percentage is not captured here. Watch Windows perf counters "
        "during the run and confirm sustained CPU stays under 70%."
    )

    if args.json:
        args.json.write_text(
            json.dumps(
                [
                    {
                        "model": r.model,
                        "compute_type": r.compute_type,
                        "beam_size": r.beam_size,
                        "utterances": r.utterances,
                        "rtf": r.rtf,
                        "p50": r.p50,
                        "p95": r.p95,
                        "drift": r.drift,
                        "rejected": r.rejected,
                        "peak_rss_mb": r.peak_rss_mb,
                        "error": r.error,
                    }
                    for r in results
                ],
                indent=2,
            ),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
