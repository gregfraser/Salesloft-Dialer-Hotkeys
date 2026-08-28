#!/usr/bin/env python3
"""Phase 1 test harness: replay a WAV file as a live PCM stream.

Feeds the transcription service exactly what the extension would send -- 16kHz
mono Int16 binary frames at real-time pace -- so the whole server pipeline can
be exercised with no Chrome involvement at all.

Real-time pacing is the point. Sending the file as fast as possible would hide
the queueing behaviour that produces cumulative drift, which is the thing Phase
1 needs to prove out.

Usage:
    python scripts/replay_wav.py sample.wav
    python scripts/replay_wav.py --speed 2 --url ws://127.0.0.1:8765/transcribe sample.wav
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import uuid
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from benchmark import TARGET_RATE, load_wav_16k  # noqa: E402

CHUNK_MS = 100


def format_clock(seconds: float) -> str:
    total = int(max(0.0, seconds))
    return f"{total // 60:02d}:{total % 60:02d}"


async def replay(path: Path, url: str, speed: float) -> int:
    try:
        import websockets
    except ImportError:
        print("error: pip install websockets", file=sys.stderr)
        return 2

    samples = load_wav_16k(path)
    duration = len(samples) / TARGET_RATE
    chunk_samples = int(TARGET_RATE * CHUNK_MS / 1000)
    call_id = str(uuid.uuid4())
    latencies: list[float] = []
    lines = 0

    print(f"Replaying {path.name}: {duration:.0f}s at {speed}x -> {url}")

    async with websockets.connect(url, max_size=None) as socket:
        async def receive() -> None:
            nonlocal lines
            async for raw in socket:
                if isinstance(raw, bytes):
                    continue
                payload = json.loads(raw)
                if payload.get("type") == "transcript":
                    lines += 1
                    if "latency_ms" in payload:
                        latencies.append(payload["latency_ms"] / 1000.0)
                    marker = " ~" if payload.get("merged", 1) > 1 else ""
                    print(
                        f"  [{format_clock(payload['start'])}]{marker} {payload['text']}"
                        f"   ({payload.get('latency_ms', 0)}ms)"
                    )
                elif payload.get("type") == "status":
                    print(f"  -- {payload['state']}: {payload.get('detail', '')}")
                elif payload.get("type") == "hello":
                    print(f"  -- connected, model {payload.get('model')}")

        receiver = asyncio.create_task(receive())

        await socket.send(json.dumps({"type": "call_start", "call_id": call_id, "ts": int(time.time())}))

        started = time.monotonic()
        for index in range(0, len(samples), chunk_samples):
            chunk = samples[index : index + chunk_samples]
            pcm = (np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()
            await socket.send(pcm)

            # Pace to the wall clock so the server sees a live arrival rate.
            audio_elapsed = (index + len(chunk)) / TARGET_RATE / speed
            drift = audio_elapsed - (time.monotonic() - started)
            if drift > 0:
                await asyncio.sleep(drift)

        await socket.send(json.dumps({"type": "call_end", "call_id": call_id, "ts": int(time.time())}))

        # Let the queue finish flushing before closing.
        try:
            await asyncio.wait_for(asyncio.shield(receiver), timeout=30.0)
        except asyncio.TimeoutError:
            pass
        receiver.cancel()

    print(f"\n{lines} transcript lines from {duration:.0f}s of audio")
    if latencies:
        ordered = sorted(latencies)
        p95 = ordered[min(len(ordered) - 1, int(round(0.95 * (len(ordered) - 1))))]
        print(f"latency P50 {statistics.median(latencies):.2f}s | P95 {p95:.2f}s | max {max(latencies):.2f}s")
        if len(latencies) >= 8:
            quarter = max(2, len(latencies) // 4)
            head = statistics.median(latencies[:quarter])
            tail = statistics.median(latencies[-quarter:])
            print(f"drift (last quarter vs first) {tail - head:+.2f}s")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--url", default="ws://127.0.0.1:8765/transcribe")
    parser.add_argument("--speed", type=float, default=1.0, help="playback rate; >1 stresses the queue")
    args = parser.parse_args()

    if not args.wav.exists():
        print(f"error: {args.wav} not found", file=sys.stderr)
        return 2
    return asyncio.run(replay(args.wav, args.url, args.speed))


if __name__ == "__main__":
    raise SystemExit(main())
