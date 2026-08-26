"""End-to-end session tests over a real WebSocket, with the model stubbed.

Exercises the actual FastAPI app, session state machine, VAD gating and
transcript emission. faster-whisper and Silero are replaced with deterministic
stubs so this runs anywhere; everything between the socket and the model is the
real code path.
"""

import json

import numpy as np
import pytest
from fastapi.testclient import TestClient

import main
from audio import float32_to_pcm16
from transcription import TranscriptionResult, TranscriptSegment

SAMPLE_RATE = 16000


class StubVAD:
    """Speech is anything above a small amplitude -- deterministic and cheap."""

    def __init__(self, *_args, **_kwargs):
        self.reset_calls = 0

    def load(self):
        pass

    def reset(self):
        self.reset_calls += 1

    def probability(self, frame: np.ndarray) -> float:
        return 1.0 if float(np.abs(frame).max()) > 0.05 else 0.0


class StubTranscriber:
    def __init__(self, *_args, **_kwargs):
        self.calls: list[int] = []
        self.loaded = True

    def load(self):
        pass

    def transcribe(self, audio: np.ndarray) -> TranscriptionResult:
        self.calls.append(int(audio.size))
        return TranscriptionResult(
            segments=[TranscriptSegment(text="We're currently using Polarion.", start=0.0, end=1.0)],
            inference_seconds=0.01,
        )


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("SLT_CONFIG", str(tmp_path / "missing.yaml"))  # use defaults
    monkeypatch.setattr(main, "SileroVAD", StubVAD)
    monkeypatch.setattr(main, "WhisperTranscriber", StubTranscriber)
    with TestClient(main.app) as test_client:
        yield test_client


def speech(seconds: float, amplitude: float = 0.5) -> bytes:
    samples = np.full(int(seconds * SAMPLE_RATE), amplitude, dtype=np.float32)
    return float32_to_pcm16(samples)


def quiet(seconds: float) -> bytes:
    return float32_to_pcm16(np.zeros(int(seconds * SAMPLE_RATE), dtype=np.float32))


def read_until(ws, message_type: str, limit: int = 12) -> dict:
    for _ in range(limit):
        payload = json.loads(ws.receive_text())
        if payload.get("type") == message_type:
            return payload
    raise AssertionError(f"no {message_type} message within {limit} messages")


# --------------------------------------------------------------------- basics
def test_health_reports_configuration(client):
    body = client.get("/health").json()
    assert body["status"] == "ok"
    assert body["save_audio"] is False
    assert body["vad_enabled"] is True


def test_connection_opens_with_hello_and_ready(client):
    with client.websocket_connect("/transcribe") as ws:
        hello = json.loads(ws.receive_text())
        assert hello["type"] == "hello"
        assert hello["sample_rate"] == SAMPLE_RATE
        status = json.loads(ws.receive_text())
        assert status["type"] == "status"
        assert status["state"] == "ready"


def test_speech_then_silence_produces_a_transcript(client):
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-1", "ts": 1}))
        ws.send_bytes(speech(1.5))
        ws.send_bytes(quiet(1.0))          # endpoint: closes the utterance
        transcript = read_until(ws, "transcript")

    assert transcript["text"] == "We're currently using Polarion."
    assert transcript["call_id"] == "call-1"
    assert transcript["final"] is True
    assert transcript["latency_ms"] >= 0


def test_silence_alone_never_reaches_the_model(client):
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-2", "ts": 1}))
        ws.send_bytes(quiet(5.0))
        ws.send_text(json.dumps({"type": "call_end", "call_id": "call-2", "ts": 2}))
        read_until(ws, "status")

    assert main.app.state.transcriber.calls == []


def test_pause_drops_audio_without_transcribing(client):
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-3", "ts": 1}))
        ws.send_text(json.dumps({"type": "pause"}))
        read_until(ws, "status")
        ws.send_bytes(speech(1.5))
        ws.send_bytes(quiet(1.0))
        ws.send_text(json.dumps({"type": "call_end", "call_id": "call-3", "ts": 2}))
        read_until(ws, "status")

    assert main.app.state.transcriber.calls == []


def test_resume_restores_transcription(client):
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-4", "ts": 1}))
        ws.send_text(json.dumps({"type": "pause"}))
        ws.send_text(json.dumps({"type": "resume"}))
        ws.send_bytes(speech(1.5))
        ws.send_bytes(quiet(1.0))
        assert read_until(ws, "transcript")["text"]


def test_call_end_flushes_speech_still_in_flight(client):
    # The prospect's last sentence must not be lost to the hangup.
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-5", "ts": 1}))
        ws.send_bytes(speech(1.5))          # no trailing silence: still open
        ws.send_text(json.dumps({"type": "call_end", "call_id": "call-5", "ts": 2}))
        assert read_until(ws, "transcript")["text"]


def test_bad_control_message_reports_error_without_closing(client):
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text('{"type":"nonsense"}')
        error = read_until(ws, "status")
        assert error["state"] == "error"
        # The socket stays usable -- a protocol slip must not end the call.
        ws.send_text(json.dumps({"type": "ping"}))
        assert read_until(ws, "status")["detail"] == "pong"


def test_a_web_page_origin_is_rejected(client):
    with pytest.raises(Exception):
        with client.websocket_connect(
            "/transcribe", headers={"origin": "https://app.salesloft.com"}
        ):
            pass


def test_extension_origin_is_accepted(client):
    with client.websocket_connect(
        "/transcribe", headers={"origin": "chrome-extension://abcdef"}
    ) as ws:
        assert json.loads(ws.receive_text())["type"] == "hello"


def test_long_monologue_flushes_before_it_ends(client):
    # 14s of unbroken speech must produce interim text at the 12s boundary.
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-6", "ts": 1}))
        ws.send_bytes(speech(14.0))
        assert read_until(ws, "transcript")["text"]
    assert main.app.state.transcriber.calls, "max-length flush never fired"


def test_transcript_is_saved_when_persistence_is_enabled(client, tmp_path):
    main.app.state.config.storage.save_transcripts = True
    main.app.state.config.storage.transcript_dir = str(tmp_path / "transcripts")
    try:
        with client.websocket_connect("/transcribe") as ws:
            read_until(ws, "status")
            ws.send_text(json.dumps({"type": "call_start", "call_id": "call-7", "ts": 1}))
            ws.send_bytes(speech(1.5))
            ws.send_bytes(quiet(1.0))
            read_until(ws, "transcript")
            ws.send_text(json.dumps({"type": "call_end", "call_id": "call-7", "ts": 2}))
            read_until(ws, "status")
    finally:
        main.app.state.config.storage.save_transcripts = False

    saved = list((tmp_path / "transcripts").glob("*.json"))
    assert len(saved) == 1
    payload = json.loads(saved[0].read_text())
    assert payload["source"] == "prospect_audio_only"
    assert payload["segments"][0]["text"] == "We're currently using Polarion."
    assert "audio" not in payload
    # The filename carries a timestamp and an opaque id, nothing identifying.
    assert "call-7"[:8] in saved[0].name


def test_nothing_is_saved_by_default(client, tmp_path):
    main.app.state.config.storage.transcript_dir = str(tmp_path / "off")
    with client.websocket_connect("/transcribe") as ws:
        read_until(ws, "status")
        ws.send_text(json.dumps({"type": "call_start", "call_id": "call-8", "ts": 1}))
        ws.send_bytes(speech(1.5))
        ws.send_bytes(quiet(1.0))
        read_until(ws, "transcript")
        ws.send_text(json.dumps({"type": "call_end", "call_id": "call-8", "ts": 2}))
        read_until(ws, "status")
    assert not (tmp_path / "off").exists()
