"""Wire protocol tests (PR-4) and origin validation (PR-10)."""

import json

import pytest

from websocket import (
    ProtocolError,
    encode_hello,
    encode_status,
    encode_transcript,
    origin_allowed,
    parse_control,
)


# ------------------------------------------------------------- control parsing
def test_call_start_parses():
    message = parse_control('{"type":"call_start","call_id":"abc","ts":1756209134}')
    assert message.type == "call_start"
    assert message.call_id == "abc"
    assert message.ts == 1756209134


@pytest.mark.parametrize("control", ["pause", "resume", "ping"])
def test_bare_controls_need_no_call_id(control):
    assert parse_control(json.dumps({"type": control})).type == control


def test_call_start_requires_a_call_id():
    with pytest.raises(ProtocolError, match="requires a call_id"):
        parse_control('{"type":"call_start"}')


def test_call_end_requires_a_call_id():
    with pytest.raises(ProtocolError, match="requires a call_id"):
        parse_control('{"type":"call_end","ts":1}')


def test_unknown_type_is_rejected():
    with pytest.raises(ProtocolError, match="unknown control type"):
        parse_control('{"type":"start_recording"}')


def test_malformed_json_is_rejected():
    with pytest.raises(ProtocolError, match="not valid JSON"):
        parse_control("{not json")


def test_non_object_payload_is_rejected():
    with pytest.raises(ProtocolError, match="must be a JSON object"):
        parse_control('["call_start"]')


def test_missing_type_is_rejected():
    with pytest.raises(ProtocolError, match="string 'type'"):
        parse_control('{"call_id":"abc"}')


def test_wrongly_typed_call_id_is_rejected():
    with pytest.raises(ProtocolError, match="must be a string"):
        parse_control('{"type":"call_start","call_id":42}')


# ------------------------------------------------------------------- encoding
def test_transcript_encodes_the_documented_shape():
    payload = json.loads(
        encode_transcript(
            call_id="abc", start=14.2, end=16.8, text="We're currently using Polarion."
        )
    )
    assert payload == {
        "type": "transcript",
        "call_id": "abc",
        "start": 14.2,
        "end": 16.8,
        "text": "We're currently using Polarion.",
        "final": True,
    }


def test_transcript_includes_latency_when_measured():
    payload = json.loads(
        encode_transcript(call_id="a", start=0, end=1, text="hi", latency_ms=2400)
    )
    assert payload["latency_ms"] == 2400


def test_transcript_flags_coalesced_lines():
    single = json.loads(encode_transcript(call_id="a", start=0, end=1, text="hi"))
    assert "merged" not in single
    coalesced = json.loads(
        encode_transcript(call_id="a", start=0, end=1, text="hi", merged=3)
    )
    assert coalesced["merged"] == 3


def test_status_encodes_known_states():
    payload = json.loads(encode_status("degraded", "Falling behind"))
    assert payload["type"] == "status"
    assert payload["state"] == "degraded"
    assert payload["detail"] == "Falling behind"


def test_status_rejects_unknown_states():
    with pytest.raises(ValueError, match="unknown status state"):
        encode_status("on fire")


def test_status_carries_extra_fields():
    payload = json.loads(encode_status("ready", "done", metrics={"p95_seconds": 3.1}))
    assert payload["metrics"]["p95_seconds"] == 3.1


def test_hello_announces_protocol_and_model():
    payload = json.loads(encode_hello("small.en", 16000))
    assert payload["type"] == "hello"
    assert payload["protocol"] == 1
    assert payload["model"] == "small.en"
    assert payload["sample_rate"] == 16000


# ------------------------------------------------------------ origin validation
def test_extension_origin_is_allowed():
    assert origin_allowed("chrome-extension://abcdef", ["chrome-extension://"])


def test_a_web_page_cannot_open_the_socket():
    # Loopback is shared with every page the browser has open.
    assert not origin_allowed("https://app.salesloft.com", ["chrome-extension://"])
    assert not origin_allowed("http://evil.example", ["chrome-extension://"])


def test_origin_can_be_pinned_to_one_extension_id():
    allowed = ["chrome-extension://aaaabbbbccccdddd"]
    assert origin_allowed("chrome-extension://aaaabbbbccccdddd", allowed)
    assert not origin_allowed("chrome-extension://zzzz", allowed)


def test_local_tooling_without_an_origin_is_configurable():
    assert origin_allowed(None, ["chrome-extension://"], allow_no_origin=True)
    assert not origin_allowed(None, ["chrome-extension://"], allow_no_origin=False)
    assert not origin_allowed("", ["chrome-extension://"], allow_no_origin=False)
