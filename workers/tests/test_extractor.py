"""Extractor handler tests (tickets 3.1/3.2): full handler flow with fakes
for the db and the LLM backend — no live Groq calls, per CLAUDE.md."""

from __future__ import annotations

from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import extractor
from scribeflow_workers.config import Settings
from scribeflow_workers.db import ExtractionSegmentRow
from scribeflow_workers.extract_backends import (
    ExtractedActionItem,
    ExtractedDecision,
    ExtractionResult,
    SentimentResult,
)
from scribeflow_workers.framework import PermanentError
from scribeflow_workers.messages import PipelineEventV1

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"v": 1, "tenant_id": TENANT, "meeting_id": MEETING}
    base.update(overrides)
    return base


class FakeCtx:
    def __init__(self) -> None:
        self.events: list[PipelineEventV1] = []
        self.published: list[tuple[str, Any]] = []

    def publish_event(self, event: PipelineEventV1) -> None:
        self.events.append(event)

    def publish(self, routing_key: str, message: Any) -> None:
        self.published.append((routing_key, message))


class FakeBackend:
    def __init__(
        self, result: ExtractionResult, sentiment: list[SentimentResult] | None = None
    ) -> None:
        self.result = result
        self.sentiment = sentiment or []
        self.extract_calls: list[str] = []
        self.sentiment_calls: list[list[tuple[str, str]]] = []

    def extract(self, transcript: str) -> ExtractionResult:
        self.extract_calls.append(transcript)
        return self.result

    def score_sentiment(self, utterances: list[tuple[str, str]]) -> list[SentimentResult]:
        self.sentiment_calls.append(utterances)
        return self.sentiment


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.segments: list[ExtractionSegmentRow] = []
        self.finalizations: list[db_module.ExtractionFinalization] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()
    monkeypatch.setattr(
        db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result
    )
    monkeypatch.setattr(
        db_module, "get_transcript_for_extraction", lambda conn, m: calls.segments
    )

    def fake_finalize(conn: Any, finalization: db_module.ExtractionFinalization) -> None:
        calls.finalizations.append(finalization)

    monkeypatch.setattr(db_module, "finalize_extraction", fake_finalize)
    monkeypatch.setattr(
        db_module, "complete_job", lambda conn, key: calls.completed.append(key)
    )
    monkeypatch.setattr(
        db_module, "fail_job", lambda conn, key, error: calls.failed.append((key, error))
    )
    return calls


class FakeConn:
    def __init__(self) -> None:
        self.rollback_calls = 0

    def rollback(self) -> None:
        self.rollback_calls += 1


def seg(id_: str, start_s: float, text: str, speaker: str | None = "Alice") -> ExtractionSegmentRow:
    return ExtractionSegmentRow(
        id=id_, start_s=start_s, end_s=start_s + 5.0, speaker_name=speaker, text=text
    )


def make_deps(
    conn: Any = None, backend: Any = None, rate_limited: bool = False
) -> extractor.Deps:
    return extractor.Deps(
        settings=Settings(),
        conn=conn if conn is not None else FakeConn(),
        backend=backend
        if backend is not None
        else FakeBackend(ExtractionResult(summary="ok", decisions=[], action_items=[])),
        rate_limited=rate_limited,
    )


def test_empty_transcript_skips_the_llm_and_writes_a_trivial_summary(
    db_calls: DbCalls,
) -> None:
    db_calls.segments = []
    backend = FakeBackend(ExtractionResult(summary="should not be used"))
    deps = make_deps(backend=backend)
    ctx = FakeCtx()
    extractor.handle_meeting_extract(payload(), ctx, deps)

    assert backend.extract_calls == []
    assert backend.sentiment_calls == []
    (finalization,) = db_calls.finalizations
    assert finalization.summary == "No speech was detected in this meeting."
    assert finalization.action_items == []
    assert finalization.sentiment == []
    assert db_calls.completed == [f"{MEETING}:extract:0"]
    assert ctx.events[0].status == "done"


def test_happy_path_writes_action_items_decisions_and_sentiment(db_calls: DbCalls) -> None:
    db_calls.segments = [seg("s0", 0.0, "let's ship by friday"), seg("s1", 300.0, "sounds good")]
    result = ExtractionResult(
        summary="Shipped Q3 plan.",
        decisions=[ExtractedDecision(text="Ship Friday", source_ts_s=0.0)],
        action_items=[
            ExtractedActionItem(
                text="Send the doc",
                owner_name="Alice",
                due_date="2026-08-01",
                confidence=0.9,
                source_ts_s=1.0,
            )
        ],
    )
    sentiment = [
        SentimentResult(segment_id="s0", label="positive", score=0.5),
        SentimentResult(segment_id="s1", label="neutral", score=0.0),
    ]
    backend = FakeBackend(result, sentiment)
    ctx = FakeCtx()
    extractor.handle_meeting_extract(payload(), ctx, make_deps(backend=backend))

    assert len(backend.extract_calls) == 1
    assert "[00:00] Alice: let's ship by friday" in backend.extract_calls[0]
    (sentiment_call,) = backend.sentiment_calls
    assert sentiment_call == [("s0", "let's ship by friday"), ("s1", "sounds good")]

    (finalization,) = db_calls.finalizations
    assert finalization.summary == "Shipped Q3 plan."
    assert finalization.decisions == [{"text": "Ship Friday", "source_ts_s": 0.0}]
    (item,) = finalization.action_items
    assert item.owner_name == "Alice"
    assert item.due_date is not None and item.due_date.year == 2026
    # source_ts_s=1.0 is nearest to s0 (start_s=0.0), well within tolerance.
    assert item.source_segment_id == "s0"
    assert {s.segment_id for s in finalization.sentiment} == {"s0", "s1"}
    assert ctx.events[0].status == "done"


def test_source_ts_beyond_tolerance_is_not_linked(db_calls: DbCalls) -> None:
    db_calls.segments = [seg("s0", 0.0, "hello")]
    result = ExtractionResult(
        summary="x",
        action_items=[
            ExtractedActionItem(text="do it", confidence=0.5, source_ts_s=1000.0)
        ],
    )
    extractor.handle_meeting_extract(
        payload(), FakeCtx(), make_deps(backend=FakeBackend(result))
    )
    (item,) = db_calls.finalizations[0].action_items
    assert item.source_segment_id is None


def test_null_source_ts_is_not_linked(db_calls: DbCalls) -> None:
    db_calls.segments = [seg("s0", 0.0, "hello")]
    result = ExtractionResult(
        summary="x",
        action_items=[ExtractedActionItem(text="do it", confidence=0.5, source_ts_s=None)],
    )
    extractor.handle_meeting_extract(
        payload(), FakeCtx(), make_deps(backend=FakeBackend(result))
    )
    (item,) = db_calls.finalizations[0].action_items
    assert item.source_segment_id is None


def test_unparseable_due_date_becomes_none(db_calls: DbCalls) -> None:
    db_calls.segments = [seg("s0", 0.0, "hello")]
    result = ExtractionResult(
        summary="x",
        action_items=[
            ExtractedActionItem(text="do it", confidence=0.5, due_date="not-a-date")
        ],
    )
    extractor.handle_meeting_extract(
        payload(), FakeCtx(), make_deps(backend=FakeBackend(result))
    )
    (item,) = db_calls.finalizations[0].action_items
    assert item.due_date is None


def test_redelivered_done_job_is_skipped(db_calls: DbCalls) -> None:
    db_calls.claim_result = False
    extractor.handle_meeting_extract(payload(), FakeCtx(), make_deps())
    assert db_calls.finalizations == []


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        extractor.handle_meeting_extract({"v": 1, "nope": True}, FakeCtx(), make_deps())


def test_backend_failure_marks_job_failed_and_reraises(db_calls: DbCalls) -> None:
    db_calls.segments = [seg("s0", 0.0, "hello")]

    class Boom:
        def extract(self, transcript: str) -> ExtractionResult:
            raise RuntimeError("groq 500")

        def score_sentiment(self, utterances: Any) -> list[SentimentResult]:
            return []

    deps = make_deps(backend=Boom())
    with pytest.raises(RuntimeError):
        extractor.handle_meeting_extract(payload(), FakeCtx(), deps)
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:extract:0"


def test_any_failure_rolls_back_the_shared_connection(db_calls: DbCalls) -> None:
    db_calls.segments = [seg("s0", 0.0, "hello")]

    class Boom:
        def extract(self, transcript: str) -> ExtractionResult:
            raise RuntimeError("groq 500")

        def score_sentiment(self, utterances: Any) -> list[SentimentResult]:
            return []

    conn = FakeConn()
    deps = make_deps(conn=conn, backend=Boom())
    with pytest.raises(RuntimeError):
        extractor.handle_meeting_extract(payload(), FakeCtx(), deps)
    assert conn.rollback_calls == 1


def test_exhausted_hook_publishes_extraction_failed_event() -> None:
    events: list[PipelineEventV1] = []

    class Ctx:
        def publish_event(self, event: PipelineEventV1) -> None:
            events.append(event)

    on_exhausted = extractor.make_on_exhausted(make_deps())
    on_exhausted(payload(), "groq down", Ctx())
    assert events[0].status == "failed"
    assert events[0].error == "groq down"


def test_transcript_truncation_keeps_head_and_tail() -> None:
    segments = [seg(f"s{i}", float(i), "x" * 200) for i in range(1000)]
    text = extractor._build_transcript_text(segments, char_budget=2000)
    assert "truncated for length" in text
    assert text.startswith("[00:00]")
    assert text.endswith(f"[{extractor._fmt_ts(999.0)}] Alice: " + "x" * 200)
