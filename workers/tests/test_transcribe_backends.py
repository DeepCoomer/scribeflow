"""parse_verbose_json: drops empty-text artifacts and carries Whisper's
confidence fields (D48) for the chunk transcriber's hallucination filter to
consume — filtering itself happens in transcriber.is_hallucinated, not here."""

from __future__ import annotations

import json
from pathlib import Path

from scribeflow_workers.transcribe_backends import parse_verbose_json

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "groq_verbose_json.json").read_text()
)


def test_drops_empty_text_segments() -> None:
    segments = parse_verbose_json(FIXTURE)
    assert [s.text for s in segments] == [
        "Welcome everyone, let's get started.",
        "First item is the Q3 roadmap.",
        "Sounds good, I'll take notes.",
    ]
    assert segments[0].start_s == 0.0
    assert segments[-1].end_s == 21.48


def test_carries_confidence_fields() -> None:
    segments = parse_verbose_json(FIXTURE)
    assert segments[0].no_speech_prob == 0.01
    assert segments[0].avg_logprob == -0.18
    assert segments[0].compression_ratio == 1.2


def test_missing_confidence_fields_default_to_none() -> None:
    payload = {
        "segments": [
            {"start": 0.0, "end": 1.0, "text": "hi"},
        ]
    }
    (segment,) = parse_verbose_json(payload)
    assert segment.no_speech_prob is None
    assert segment.avg_logprob is None
    assert segment.compression_ratio is None
