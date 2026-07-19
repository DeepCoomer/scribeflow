"""Extraction/sentiment backend tests (tickets 3.1/3.2): the retry-on-invalid
JSON loop and schema validation, against a fake Groq client — no live Groq
calls, per CLAUDE.md."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from scribeflow_workers.extract_backends import (
    GroqExtractionBackend,
    SentimentResult,
    _chat_json,
)


@dataclass
class _Message:
    content: str


@dataclass
class _Choice:
    message: _Message


@dataclass
class _Response:
    choices: list[_Choice]


@dataclass
class FakeCompletions:
    replies: list[str]
    calls: list[list[dict[str, str]]] = field(default_factory=list)

    def create(self, *, model: str, messages: list[dict[str, str]], **_kwargs: Any) -> _Response:
        self.calls.append(messages)
        content = self.replies[len(self.calls) - 1]
        return _Response(choices=[_Choice(message=_Message(content=content))])


@dataclass
class FakeChat:
    completions: FakeCompletions


@dataclass
class FakeClient:
    chat: FakeChat


def fake_client(replies: list[str]) -> FakeClient:
    return FakeClient(chat=FakeChat(completions=FakeCompletions(replies=replies)))


def make_backend(client: FakeClient) -> GroqExtractionBackend:
    backend = object.__new__(GroqExtractionBackend)
    backend._client = client  # type: ignore[assignment]
    backend._model = "llama-3.3-70b-versatile"
    return backend


# -- _chat_json: the retry-on-invalid loop -----------------------------------


def test_chat_json_returns_parsed_object_on_first_try() -> None:
    client = fake_client(['{"a": 1}'])
    result = _chat_json(client, "m", "sys", "user")
    assert result == {"a": 1}
    assert len(client.chat.completions.calls) == 1


def test_chat_json_reprompts_on_malformed_json_then_succeeds() -> None:
    client = fake_client(["not json", '{"a": 1}'])
    result = _chat_json(client, "m", "sys", "user")
    assert result == {"a": 1}
    assert len(client.chat.completions.calls) == 2
    # The corrected retry's message list carries the bad reply + the nudge.
    second_call = client.chat.completions.calls[1]
    assert second_call[-2]["content"] == "not json"
    assert "not a valid JSON object" in second_call[-1]["content"]


def test_chat_json_reprompts_when_json_is_not_an_object() -> None:
    client = fake_client(["[1, 2, 3]", '{"a": 1}'])
    result = _chat_json(client, "m", "sys", "user")
    assert result == {"a": 1}
    assert len(client.chat.completions.calls) == 2


def test_chat_json_gives_up_after_max_attempts() -> None:
    client = fake_client(["nope", "still nope", "nope again", "extra"])
    with pytest.raises(ValueError, match="no valid JSON object after 3 attempts"):
        _chat_json(client, "m", "sys", "user")
    assert len(client.chat.completions.calls) == 3


# -- GroqExtractionBackend.extract -------------------------------------------


def test_extract_happy_path() -> None:
    payload = {
        "summary": "Discussed Q3 roadmap.",
        "decisions": [{"text": "Ship by Friday", "source_ts_s": 12.0}],
        "action_items": [
            {
                "text": "Send the doc",
                "owner_name": "Alice",
                "due_date": "2026-08-01",
                "confidence": 0.9,
                "source_ts_s": 30.0,
            }
        ],
    }
    backend = make_backend(fake_client([json.dumps(payload)]))
    result = backend.extract("[00:00] Alice: let's ship by friday")
    assert result.summary == "Discussed Q3 roadmap."
    assert result.decisions[0].text == "Ship by Friday"
    assert result.action_items[0].owner_name == "Alice"
    assert result.action_items[0].confidence == 0.9


def test_extract_raises_when_json_valid_but_schema_invalid() -> None:
    # confidence out of [0, 1] range fails pydantic validation every time,
    # so the retry loop exhausts and the schema-validation ValueError fires.
    bad = {
        "summary": "x",
        "decisions": [],
        "action_items": [
            {"text": "t", "confidence": 5.0, "owner_name": None, "due_date": None}
        ],
    }
    backend = make_backend(fake_client([json.dumps(bad)] * 3))
    with pytest.raises(ValueError, match="schema validation"):
        backend.extract("transcript")


def test_extract_defaults_missing_arrays_to_empty() -> None:
    backend = make_backend(fake_client([json.dumps({"summary": "short meeting"})]))
    result = backend.extract("transcript")
    assert result.decisions == []
    assert result.action_items == []


# -- GroqExtractionBackend.score_sentiment -----------------------------------


def test_score_sentiment_batches_and_maps_results() -> None:
    utterances = [(f"seg-{i}", f"text {i}") for i in range(5)]
    reply = json.dumps(
        {
            "results": [
                {"segment_id": f"seg-{i}", "label": "neutral", "score": 0.0}
                for i in range(5)
            ]
        }
    )
    backend = make_backend(fake_client([reply]))
    results = backend.score_sentiment(utterances)
    assert len(results) == 5
    assert all(isinstance(r, SentimentResult) for r in results)
    assert results[0].segment_id == "seg-0"


def test_score_sentiment_issues_one_call_per_batch() -> None:
    from scribeflow_workers.extract_backends import SENTIMENT_BATCH_SIZE

    utterances = [(f"seg-{i}", "text") for i in range(SENTIMENT_BATCH_SIZE + 5)]
    replies = [
        json.dumps(
            {
                "results": [
                    {"segment_id": f"seg-{i}", "label": "neutral", "score": 0.0}
                    for i in range(SENTIMENT_BATCH_SIZE)
                ]
            }
        ),
        json.dumps(
            {
                "results": [
                    {"segment_id": f"seg-{i}", "label": "neutral", "score": 0.0}
                    for i in range(SENTIMENT_BATCH_SIZE, SENTIMENT_BATCH_SIZE + 5)
                ]
            }
        ),
    ]
    backend = make_backend(fake_client(replies))
    results = backend.score_sentiment(utterances)
    assert len(results) == SENTIMENT_BATCH_SIZE + 5
    assert len(backend._client.chat.completions.calls) == 2  # type: ignore[attr-defined]


def test_score_sentiment_empty_input_makes_no_calls() -> None:
    backend = make_backend(fake_client([]))
    assert backend.score_sentiment([]) == []
    assert backend._client.chat.completions.calls == []  # type: ignore[attr-defined]
