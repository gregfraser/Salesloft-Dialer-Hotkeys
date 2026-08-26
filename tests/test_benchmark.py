"""Phase 0 benchmark scoring and audio handling.

The queue model these tests cover is what turns measured inference times into
the latency and drift numbers the go/no-go decision rests on, so it is worth
holding to the same standard as the service itself.
"""

import sys
import wave
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from benchmark import (  # noqa: E402
    Result,
    load_wav_16k,
    proper_noun_recall,
    word_error_rate,
)


# ----------------------------------------------------------------------- WER
def test_identical_text_scores_zero():
    assert word_error_rate("we use polarion", "we use polarion") == 0.0


def test_case_is_ignored():
    assert word_error_rate("We use Polarion", "we use polarion") == 0.0


def test_one_substitution_in_three_words():
    assert word_error_rate("we use polarion", "we use codebeamer") == pytest.approx(1 / 3)


def test_deletions_and_insertions_count():
    assert word_error_rate("a b c d", "a b d") == pytest.approx(0.25)
    assert word_error_rate("a b c", "a b x c") == pytest.approx(1 / 3)


def test_empty_reference_is_not_a_division_by_zero():
    assert word_error_rate("", "anything at all") == 0.0


def test_total_miss_scores_one():
    assert word_error_rate("polarion", "") == 1.0


# ------------------------------------------------------------- term recall
def test_term_recall_finds_domain_vocabulary():
    text = "we're on Polarion and the DHF review is manual"
    assert proper_noun_recall(["Polarion", "DHF"], text) == 1.0


def test_term_recall_reports_what_was_lost():
    # The failure that matters: narrowband audio mangles proper nouns first,
    # and overall WER hides it.
    text = "we're on polarity and the D H F review is manual"
    assert proper_noun_recall(["Polarion", "DHF"], text) == 0.0


def test_term_recall_is_partial():
    assert proper_noun_recall(["Polarion", "Codebeamer"], "we use polarion") == 0.5


def test_no_terms_means_no_score():
    assert proper_noun_recall([], "anything") is None


# ------------------------------------------------------------- queue model
def make_result(latencies: list[float]) -> Result:
    result = Result(model="test", compute_type="int8", beam_size=1)
    result.latencies = latencies
    result.utterances = len(latencies)
    result.audio_seconds = 100.0
    result.inference_seconds = 50.0
    return result


def test_percentiles_come_from_the_measured_latencies():
    result = make_result([1.0, 2.0, 3.0, 4.0, 5.0])
    assert result.p50 == 3.0
    assert result.p95 == 5.0


def test_rtf_is_inference_over_audio():
    assert make_result([1.0]).rtf == 0.5


def test_a_steady_config_meets_targets():
    assert make_result([2.0] * 20).meets_targets()


def test_a_slow_config_fails_on_p95():
    # Latency inside target at the median but not at the tail.
    assert not make_result([1.0] * 18 + [9.0, 9.0]).meets_targets()


def test_a_drifting_config_fails_even_when_fast_on_average():
    # This is §9's point: 2s that grows to 30s is unusable, and a mean would
    # not show it.
    result = make_result([1.0] * 10 + [1.0] * 10)
    result.drift = 6.0
    assert not result.meets_targets()


def test_an_errored_config_never_counts_as_viable():
    result = make_result([1.0] * 20)
    result.error = "load failed"
    assert not result.meets_targets()


# --------------------------------------------------------------- audio load
def write_wav(path: Path, samples: np.ndarray, rate: int, channels: int = 1) -> None:
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(channels)
        handle.setsampwidth(2)
        handle.setframerate(rate)
        handle.writeframes((np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes())


def test_a_16k_mono_wav_loads_unchanged(tmp_path):
    tone = (0.5 * np.sin(2 * np.pi * 440 * np.arange(16000) / 16000)).astype(np.float32)
    path = tmp_path / "mono.wav"
    write_wav(path, tone, 16000)
    loaded = load_wav_16k(path)
    assert len(loaded) == 16000
    assert np.allclose(loaded, tone, atol=1e-3)


def test_an_8k_call_recording_is_upsampled(tmp_path):
    # PSTN audio commonly arrives at 8kHz; the benchmark must handle it.
    tone = (0.5 * np.sin(2 * np.pi * 300 * np.arange(8000) / 8000)).astype(np.float32)
    path = tmp_path / "narrowband.wav"
    write_wav(path, tone, 8000)
    loaded = load_wav_16k(path)
    assert abs(len(loaded) - 16000) <= 2
    assert float(np.sqrt(np.mean(loaded**2))) > 0.2


def test_a_48k_wav_is_downsampled_without_aliasing(tmp_path):
    # 12kHz content must be filtered out, not folded down to 4kHz.
    tone = (0.8 * np.sin(2 * np.pi * 12000 * np.arange(48000) / 48000)).astype(np.float32)
    path = tmp_path / "wideband.wav"
    write_wav(path, tone, 48000)
    loaded = load_wav_16k(path)
    assert float(np.sqrt(np.mean(loaded**2))) < 0.05


def test_stereo_is_mixed_to_mono(tmp_path):
    frames = 16000
    stereo = np.zeros(frames * 2, dtype=np.float32)
    stereo[0::2] = 0.5
    stereo[1::2] = 0.5
    path = tmp_path / "stereo.wav"
    write_wav(path, stereo, 16000, channels=2)
    loaded = load_wav_16k(path)
    assert len(loaded) == frames
    assert np.allclose(loaded, 0.5, atol=1e-3)


def test_non_16_bit_audio_is_rejected_clearly(tmp_path):
    path = tmp_path / "eight.wav"
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(1)
        handle.setsampwidth(1)
        handle.setframerate(16000)
        handle.writeframes(b"\x00" * 100)
    with pytest.raises(ValueError, match="16-bit PCM"):
        load_wav_16k(path)
