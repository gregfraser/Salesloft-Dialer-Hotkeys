"""Salesloft Live Transcriber -- local transcription service.

Binds to loopback only. Receives 16kHz mono Int16 PCM over a WebSocket, gates
it through Silero VAD, transcribes complete utterances with faster-whisper, and
streams text back. Audio exists only in memory and is freed as soon as
inference returns; no code path in this service opens a file for audio.

Run with:  python -m uvicorn main:app --host 127.0.0.1 --port 8765
      or:  python main.py
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse

from audio import FrameSplitter
from config import Config, load_config
from transcription import LatencyTracker, UtteranceQueue, WhisperTranscriber
from vad import Endpointer, SileroVAD
from websocket import (
    ProtocolError,
    encode_hello,
    encode_status,
    encode_transcript,
    origin_allowed,
    parse_control,
)

logging.basicConfig(
    level=os.environ.get("SLT_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)
log = logging.getLogger("transcriber")

def new_inference_pool() -> ThreadPoolExecutor:
    """One worker for the whole service: inference is serialized so Whisper can
    never take more than one core's worth of scheduling pressure away from the
    call itself. Owned by the app lifespan, not by a connection."""
    return ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")


def lower_priority() -> None:
    """Drop below normal priority so inference never competes with WebRTC.

    A perfect passthrough still produces choppy call audio if Whisper starves
    Twilio's encoder on a thermally limited laptop.
    """
    try:
        import psutil

        process = psutil.Process()
        if hasattr(psutil, "BELOW_NORMAL_PRIORITY_CLASS"):   # Windows
            process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS)
        else:                                                 # POSIX
            process.nice(10)
        log.info("Process priority lowered")
    except Exception as exc:                                  # noqa: BLE001
        log.warning("Could not lower process priority: %s", exc)


class Session:
    """One WebSocket connection: VAD gating, queueing, inference, transmission."""

    def __init__(
        self,
        ws: WebSocket,
        cfg: Config,
        vad: SileroVAD,
        transcriber: WhisperTranscriber,
        pool: ThreadPoolExecutor,
    ):
        self.ws = ws
        self.cfg = cfg
        self.vad = vad
        self.transcriber = transcriber
        self.pool = pool

        self.splitter = FrameSplitter(cfg.frame_samples)
        self.endpointer = self._new_endpointer()
        self.queue = UtteranceQueue(
            max_depth=cfg.transcription.max_queue_depth,
            max_merge_seconds=cfg.transcription.max_merge_seconds,
            merge_gap_ms=cfg.transcription.merge_gap_ms,
            sample_rate=cfg.sample_rate,
        )
        self.tracker = LatencyTracker()

        self.call_id: str | None = None
        self.call_started_at: datetime | None = None
        self.paused = False
        self.segments: list[dict] = []
        self._work = asyncio.Event()
        self._idle = asyncio.Event()
        self._idle.set()
        self._closing = False
        self._degraded_sent = False

    def _new_endpointer(self) -> Endpointer:
        vad_cfg = self.cfg.vad
        return Endpointer(
            sample_rate=self.cfg.sample_rate,
            frame_samples=self.cfg.frame_samples,
            speech_threshold=vad_cfg.speech_threshold,
            silence_threshold_ms=vad_cfg.silence_threshold_ms,
            max_utterance_seconds=vad_cfg.max_utterance_seconds,
            min_utterance_ms=vad_cfg.min_utterance_ms,
            pre_roll_ms=vad_cfg.pre_roll_ms,
            post_roll_ms=vad_cfg.post_roll_ms,
            speech_start_frames=vad_cfg.speech_start_frames,
        )

    # ---------------------------------------------------------------- lifecycle
    async def run(self) -> None:
        worker = asyncio.create_task(self._worker())
        try:
            await self.ws.send_text(
                encode_hello(self.cfg.transcription.model, self.cfg.sample_rate)
            )
            await self.ws.send_text(encode_status("ready", "Transcription ready"))
            await self._receive_loop()
        except WebSocketDisconnect:
            log.info("Client disconnected")
        finally:
            self._closing = True
            self._work.set()
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait_for(worker, timeout=30.0)
            worker.cancel()

    async def _receive_loop(self) -> None:
        while True:
            message = await self.ws.receive()
            if message.get("type") == "websocket.disconnect":
                return
            if (payload := message.get("bytes")) is not None:
                self._on_audio(payload)
            elif (text := message.get("text")) is not None:
                await self._on_control(text)

    # ------------------------------------------------------------------- inputs
    def _on_audio(self, payload: bytes) -> None:
        if self.paused:
            return  # Dropped, never buffered. Audio has nowhere else to go.
        try:
            for frame in self.splitter.push(payload):
                probability = self.vad.probability(frame) if self.cfg.vad.enabled else 1.0
                utterance = self.endpointer.push(probability, frame)
                if utterance is not None:
                    self._enqueue(utterance)
        except Exception as exc:  # noqa: BLE001
            # A failure here must never propagate: the call is still live.
            log.exception("Audio processing failed: %s", exc)

    async def _on_control(self, raw: str) -> None:
        try:
            control = parse_control(raw)
        except ProtocolError as exc:
            log.warning("Bad control message: %s", exc)
            await self._send(encode_status("error", f"Bad control message: {exc}"))
            return

        if control.type == "call_start":
            self._start_call(control.call_id)
            await self._send(encode_status("ready", "Listening"))
        elif control.type == "call_end":
            await self._end_call()
        elif control.type == "pause":
            self.paused = True
            await self._send(encode_status("ready", "Paused"))
        elif control.type == "resume":
            self.paused = False
            await self._send(encode_status("ready", "Listening"))
        elif control.type == "ping":
            await self._send(encode_status("ready", "pong"))

    def _start_call(self, call_id: str | None) -> None:
        self.call_id = call_id or str(uuid.uuid4())
        self.call_started_at = datetime.now(timezone.utc).astimezone()
        self.splitter.reset()
        self.endpointer.reset()
        self.queue.clear()
        self.tracker = LatencyTracker()
        self.segments = []
        self.paused = False
        self._degraded_sent = False
        self.vad.reset()
        log.info("Call started: %s", self.call_id)

    async def _end_call(self) -> None:
        # FINALIZING: close any open utterance and let the queue drain so the
        # last thing the prospect said still reaches the panel.
        trailing = self.endpointer.flush()
        if trailing is not None:
            self._enqueue(trailing)
        await self._drain()

        summary = self.tracker.summary()
        log.info("Call ended: %s | %s", self.call_id, json.dumps(summary))
        app.state.last_metrics = {"call_id": self.call_id, **summary}

        saved_to = self._save_transcript()
        detail = f"Transcript saved to {saved_to}" if saved_to else "Call ended"
        await self._send(encode_status("ready", detail, metrics=summary))

        self.call_id = None
        self.call_started_at = None

    def _enqueue(self, utterance) -> None:
        utterance.enqueued_at = time.monotonic()
        stats = self.queue.put(utterance)
        if stats.degraded and not self._degraded_sent:
            self._degraded_sent = True
            detail = (
                f"Falling behind: merged {stats.merged} utterance(s)"
                if stats.merged
                else f"Falling behind: dropped {stats.dropped} utterance(s)"
            )
            log.warning(detail)
            asyncio.create_task(self._send(encode_status("degraded", detail)))
        self._idle.clear()
        self._work.set()

    # -------------------------------------------------------------- inference
    async def _worker(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            await self._work.wait()
            self._work.clear()
            if self._closing and not len(self.queue):
                return
            while True:
                utterance = self.queue.get()
                if utterance is None:
                    break
                try:
                    await self._transcribe(loop, utterance)
                except Exception as exc:  # noqa: BLE001
                    log.exception("Inference failed: %s", exc)
                    await self._send(encode_status("degraded", "Transcription error"))
                finally:
                    # Free the audio the moment it is no longer needed. This is
                    # the whole retention policy: buffers die with the utterance.
                    utterance.audio = None
            self._idle.set()

    async def _transcribe(self, loop: asyncio.AbstractEventLoop, utterance) -> None:
        result = await loop.run_in_executor(
            self.pool, self.transcriber.transcribe, utterance.audio
        )
        latency = time.monotonic() - utterance.enqueued_at

        for reason in result.rejected:
            log.debug("Filtered segment %s", reason)

        for segment in result.segments:
            start = utterance.start + segment.start
            end = utterance.start + segment.end
            self.segments.append(
                {"start": round(start, 2), "end": round(end, 2), "text": segment.text}
            )
            await self._send(
                encode_transcript(
                    call_id=self.call_id,
                    start=start,
                    end=end,
                    text=segment.text,
                    final=True,
                    latency_ms=int(latency * 1000),
                    merged=utterance.merged,
                )
            )

        if result.segments:
            self.tracker.record(call_elapsed=utterance.end, latency=latency)
            log.info(
                "utterance %.1fs -> %.2fs inference, %.2fs latency, %d segment(s)",
                utterance.duration,
                result.inference_seconds,
                latency,
                len(result.segments),
            )

    async def _drain(self, timeout: float = 30.0) -> None:
        self._work.set()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._idle.wait(), timeout=timeout)

    # ------------------------------------------------------------- persistence
    def _save_transcript(self) -> str | None:
        if not self.cfg.storage.save_transcripts or not self.segments:
            return None
        try:
            directory = Path(self.cfg.storage.transcript_dir).expanduser()
            directory.mkdir(parents=True, exist_ok=True)
            started = self.call_started_at or datetime.now(timezone.utc).astimezone()
            ended = datetime.now(timezone.utc).astimezone()
            # Filename carries a timestamp and an opaque id -- never a prospect
            # name or phone number.
            path = directory / f"{started.strftime('%Y-%m-%dT%H-%M-%S')}_{(self.call_id or '')[:8]}.json"
            payload = {
                "call_id": self.call_id,
                "started_at": started.isoformat(),
                "ended_at": ended.isoformat(),
                "duration_seconds": int((ended - started).total_seconds()),
                # Records that V1 heard one side only, so nothing downstream
                # can mistake this for a full conversation.
                "source": "prospect_audio_only",
                "model": self.cfg.transcription.model,
                "segments": self.segments,
            }
            path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
            log.info("Transcript saved: %s", path)
            return str(path)
        except Exception as exc:  # noqa: BLE001
            log.exception("Could not save transcript: %s", exc)
            return None

    async def _send(self, message: str) -> None:
        with contextlib.suppress(Exception):
            await self.ws.send_text(message)


@asynccontextmanager
async def lifespan(application: FastAPI):
    cfg = load_config(os.environ.get("SLT_CONFIG"))
    application.state.config = cfg
    application.state.last_metrics = None

    if cfg.server.lower_process_priority:
        lower_priority()

    vad = SileroVAD(sample_rate=cfg.sample_rate)
    if cfg.vad.enabled:
        # Loud failure here is correct: this is startup, not a live call. A
        # service that silently ran without gating would transcribe silence
        # continuously and peg the CPU.
        vad.load()
        log.info("Silero VAD loaded")

    transcriber = WhisperTranscriber(cfg.transcription)
    transcriber.load()

    application.state.vad = vad
    application.state.transcriber = transcriber
    application.state.inference_pool = new_inference_pool()
    log.info("Listening on ws://%s:%d/transcribe", cfg.server.host, cfg.server.port)
    yield
    application.state.inference_pool.shutdown(wait=False)


app = FastAPI(title="Salesloft Live Transcriber", lifespan=lifespan)


@app.get("/health")
async def health() -> JSONResponse:
    cfg: Config = app.state.config
    return JSONResponse(
        {
            "status": "ok",
            "model": cfg.transcription.model,
            "compute_type": cfg.transcription.compute_type,
            "vad_enabled": cfg.vad.enabled,
            "model_loaded": app.state.transcriber.loaded,
            "sample_rate": cfg.sample_rate,
            "save_transcripts": cfg.storage.save_transcripts,
            "save_audio": False,
        }
    )


@app.get("/metrics")
async def metrics() -> JSONResponse:
    return JSONResponse({"last_call": app.state.last_metrics})


@app.websocket("/transcribe")
async def transcribe(ws: WebSocket) -> None:
    cfg: Config = app.state.config
    origin = ws.headers.get("origin")
    if not origin_allowed(origin, cfg.server.allowed_origins, cfg.server.allow_no_origin):
        log.warning("Rejected connection from origin: %r", origin)
        await ws.close(code=1008)
        return

    await ws.accept()
    session = Session(
        ws, cfg, app.state.vad, app.state.transcriber, app.state.inference_pool
    )
    try:
        await session.run()
    except Exception as exc:  # noqa: BLE001
        log.exception("Session ended abnormally: %s", exc)
    finally:
        with contextlib.suppress(Exception):
            await ws.close()


if __name__ == "__main__":
    import uvicorn

    startup_cfg = load_config(os.environ.get("SLT_CONFIG"))
    uvicorn.run(
        app,
        host=startup_cfg.server.host,
        port=startup_cfg.server.port,
        log_level="info",
    )
