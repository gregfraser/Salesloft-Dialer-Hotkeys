"""WebSocket protocol: framing, validation and origin checks (PR-4, PR-10).

Audio travels as raw binary frames; everything else is JSON. Base64-encoding
PCM inside JSON would inflate the payload by a third and add encode/decode cost
on both ends for no benefit.

The encode/parse helpers are pure so the wire format can be tested without
standing up a server.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

PROTOCOL_VERSION = 1

# Extension -> server
CONTROL_TYPES = frozenset({"call_start", "call_end", "pause", "resume", "ping"})
# Server -> extension
STATUS_STATES = frozenset({"ready", "busy", "degraded", "error", "offline"})


class ProtocolError(ValueError):
    """Malformed control message. Closes the connection, never the call."""


@dataclass
class ControlMessage:
    type: str
    call_id: str | None = None
    ts: int | None = None
    raw: dict[str, Any] | None = None


def parse_control(raw: str) -> ControlMessage:
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ProtocolError(f"not valid JSON: {exc}") from exc
    if not isinstance(payload, dict):
        raise ProtocolError("control message must be a JSON object")

    message_type = payload.get("type")
    if not isinstance(message_type, str):
        raise ProtocolError("control message needs a string 'type'")
    if message_type not in CONTROL_TYPES:
        raise ProtocolError(f"unknown control type: {message_type}")

    call_id = payload.get("call_id")
    if call_id is not None and not isinstance(call_id, str):
        raise ProtocolError("'call_id' must be a string when present")
    if message_type in {"call_start", "call_end"} and not call_id:
        raise ProtocolError(f"'{message_type}' requires a call_id")

    ts = payload.get("ts")
    if ts is not None and not isinstance(ts, (int, float)):
        raise ProtocolError("'ts' must be numeric when present")

    return ControlMessage(
        type=message_type,
        call_id=call_id,
        ts=int(ts) if isinstance(ts, (int, float)) else None,
        raw=payload,
    )


def encode_transcript(
    *,
    call_id: str | None,
    start: float,
    end: float,
    text: str,
    final: bool = True,
    latency_ms: int | None = None,
    merged: int = 1,
) -> str:
    message: dict[str, Any] = {
        "type": "transcript",
        "call_id": call_id,
        "start": round(start, 2),
        "end": round(end, 2),
        "text": text,
        "final": final,
    }
    if latency_ms is not None:
        message["latency_ms"] = latency_ms
    if merged > 1:
        # Tells the panel this line covers speech that was coalesced under
        # load, so its timestamps are approximate.
        message["merged"] = merged
    return json.dumps(message)


def encode_status(state: str, detail: str = "", **extra: Any) -> str:
    if state not in STATUS_STATES:
        raise ValueError(f"unknown status state: {state}")
    message: dict[str, Any] = {"type": "status", "state": state, "detail": detail}
    message.update(extra)
    return json.dumps(message)


def encode_hello(model: str, sample_rate: int) -> str:
    """Sent on connect so the panel can show what it is talking to."""
    return json.dumps(
        {
            "type": "hello",
            "protocol": PROTOCOL_VERSION,
            "model": model,
            "sample_rate": sample_rate,
        }
    )


def origin_allowed(
    origin: str | None,
    allowed_prefixes: list[str],
    allow_no_origin: bool = True,
) -> bool:
    """Reject connections that did not come from the extension.

    The service binds to loopback, but loopback is shared with every other
    process and every page the browser has open, so a page could otherwise
    open a socket to it.
    """
    if origin is None or origin == "":
        return allow_no_origin
    return any(origin.startswith(prefix) for prefix in allowed_prefixes if prefix)
