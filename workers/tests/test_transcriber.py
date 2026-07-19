"""Chunk transcriber handler tests — full handler flow with fakes for the
db, R2, and backend (recorded Groq fixture; no live calls per CLAUDE.md)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import r2 as r2_module
from scribeflow_workers import transcriber
from scribeflow_workers.config import Settings
from scribeflow_workers.db import ChunkCompletion, FanIn, SegmentRow
from scribeflow_workers.framework import PermanentError
from scribeflow_workers.messages import MeetingStitchV1, PipelineEventV1
from scribeflow_workers.topology import MEETING_STITCH
from scribeflow_workers.transcribe_backends import Segment, parse_verbose_json

FIXTURE = json.loads(
    (Path(__file__).parent / "fixtures" / "groq_verbose_json.json").read_text()
)

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "v": 1,
        "tenant_id": TENANT,
        "meeting_id": MEETING,
        "chunk_idx": 0,
        "total_chunks": 3,
        "offset_s": 0.0,
        "r2_key": f"tenant/{TENANT}/meeting/{MEETING}/chunks/0.flac",
    }
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
    def __init__(self, segments: list[Segment]) -> None:
        self._segments = segments
        self.calls: list[Path] = []

    def transcribe(self, audio_path: Path) -> list[Segment]:
        self.calls.append(audio_path)
        return self._segments


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.complete_calls: list[tuple[str, str, int, str, list[SegmentRow]]] = []
        self.complete_result = ChunkCompletion(transitioned=True, chunks_done=1, total_chunks=3)
        self.exhaust_calls: list[tuple[str, str]] = []
        self.exhaust_result = ChunkCompletion(
            transitioned=True, chunks_done=1, total_chunks=3
        )
        self.fan_in_result = FanIn(
            chunks_done=1, total_chunks=3, diarization_done=False, status="transcribing"
        )
        self.failed: list[tuple[str, str]] = []


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()

    monkeypatch.setattr(
        db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result
    )

    def fake_complete(conn: Any, t: str, m: str, chunk_idx: int, key: str, rows: list[SegmentRow]) -> ChunkCompletion:
        calls.complete_calls.append((t, m, chunk_idx, key, rows))
        return calls.complete_result

    monkeypatch.setattr(db_module, "complete_chunk_job", fake_complete)

    def fake_exhaust(conn: Any, m: str, key: str) -> ChunkCompletion:
        calls.exhaust_calls.append((m, key))
        return calls.exhaust_result

    monkeypatch.setattr(db_module, "exhaust_chunk_job", fake_exhaust)
    monkeypatch.setattr(db_module, "get_fan_in", lambda conn, m: calls.fan_in_result)
    monkeypatch.setattr(
        db_module, "fail_job", lambda conn, key, error: calls.failed.append((key, error))
    )
    monkeypatch.setattr(
        r2_module, "download", lambda client, bucket, key, dest: dest / "chunk.flac"
    )
    return calls


class FakeConn:
    def __init__(self) -> None:
        self.rollback_calls = 0

    def rollback(self) -> None:
        self.rollback_calls += 1


def make_deps(conn: Any = None) -> transcriber.Deps:
    return transcriber.Deps(
        settings=Settings(),
        conn=conn if conn is not None else FakeConn(),
        backend=FakeBackend(parse_verbose_json(FIXTURE)),
        r2_client=object(),
        rate_limited=False,
    )


def test_happy_path_writes_segments_and_shifts_offset(db_calls: DbCalls) -> None:
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(offset_s=100.0), ctx, make_deps())

    (call,) = db_calls.complete_calls
    tenant_id, meeting_id, chunk_idx, key, rows = call
    assert (tenant_id, meeting_id, chunk_idx, key) == (
        TENANT, MEETING, 0, f"{MEETING}:transcribe:0",
    )
    assert len(rows) == 3
    assert rows[0].start_s == 100.0  # shifted by offset_s
    assert rows[-1].end_s == 121.48


def test_hallucinated_segments_are_dropped(db_calls: DbCalls) -> None:
    segments = parse_verbose_json(FIXTURE) + [
        Segment(
            start_s=25.0,
            end_s=27.0,
            text="Thank you for watching.",
            no_speech_prob=0.75,
            avg_logprob=-1.2,
            compression_ratio=1.0,
        )
    ]
    deps = make_deps()
    deps.backend = FakeBackend(segments)
    transcriber.handle_chunk_transcribe(payload(), FakeCtx(), deps)

    (call,) = db_calls.complete_calls
    rows = call[4]
    assert len(rows) == 3
    assert all("Thank you for watching" not in r.text for r in rows)


def test_repetition_hallucination_dropped_by_compression_ratio(db_calls: DbCalls) -> None:
    segments = [
        Segment(start_s=0.0, end_s=2.0, text="ok ok ok ok ok", compression_ratio=3.0)
    ]
    deps = make_deps()
    deps.backend = FakeBackend(segments)
    transcriber.handle_chunk_transcribe(payload(), FakeCtx(), deps)

    (call,) = db_calls.complete_calls
    assert call[4] == []


def test_all_hallucinated_chunk_is_still_a_success(db_calls: DbCalls) -> None:
    segments = [
        Segment(
            start_s=0.0, end_s=2.0, text="silence", no_speech_prob=0.9, avg_logprob=-2.0
        )
    ]
    deps = make_deps()
    deps.backend = FakeBackend(segments)
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, deps)

    (call,) = db_calls.complete_calls
    assert call[4] == []
    assert db_calls.failed == []


def test_fan_in_not_closed_does_not_publish_stitch(db_calls: DbCalls) -> None:
    db_calls.complete_result = ChunkCompletion(
        transitioned=True, chunks_done=1, total_chunks=3
    )
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, make_deps())
    assert ctx.published == []


def test_last_chunk_triggers_stitch_when_diarization_done(db_calls: DbCalls) -> None:
    db_calls.complete_result = ChunkCompletion(
        transitioned=True, chunks_done=3, total_chunks=3
    )
    db_calls.fan_in_result = FanIn(
        chunks_done=3, total_chunks=3, diarization_done=True, status="transcribing"
    )
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, make_deps())

    ((routing_key, message),) = ctx.published
    assert routing_key == MEETING_STITCH
    assert message == MeetingStitchV1(tenant_id=TENANT, meeting_id=MEETING)


def test_last_chunk_without_diarization_does_not_trigger_stitch(db_calls: DbCalls) -> None:
    db_calls.complete_result = ChunkCompletion(
        transitioned=True, chunks_done=3, total_chunks=3
    )
    db_calls.fan_in_result = FanIn(
        chunks_done=3, total_chunks=3, diarization_done=False, status="transcribing"
    )
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, make_deps())
    assert ctx.published == []


def test_redelivered_done_job_rechecks_fan_in_and_republishes_stitch(
    db_calls: DbCalls,
) -> None:
    db_calls.claim_result = False
    db_calls.fan_in_result = FanIn(
        chunks_done=3, total_chunks=3, diarization_done=True, status="transcribing"
    )
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, make_deps())

    assert db_calls.complete_calls == []
    ((routing_key, message),) = ctx.published
    assert routing_key == MEETING_STITCH
    assert message == MeetingStitchV1(tenant_id=TENANT, meeting_id=MEETING)


def test_redelivered_done_job_skips_republish_once_already_stitched(
    db_calls: DbCalls,
) -> None:
    db_calls.claim_result = False
    db_calls.fan_in_result = FanIn(
        chunks_done=3, total_chunks=3, diarization_done=True, status="done"
    )
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, make_deps())
    assert ctx.published == []


def test_exhausted_hook_increments_fan_in_and_can_trigger_stitch(db_calls: DbCalls) -> None:
    db_calls.exhaust_result = ChunkCompletion(
        transitioned=True, chunks_done=3, total_chunks=3
    )
    db_calls.fan_in_result = FanIn(
        chunks_done=3, total_chunks=3, diarization_done=True, status="transcribing"
    )
    ctx = FakeCtx()
    on_exhausted = transcriber.make_on_exhausted(make_deps())
    on_exhausted(payload(), "groq 500", ctx)

    assert db_calls.exhaust_calls == [(MEETING, f"{MEETING}:transcribe:0")]
    ((routing_key, message),) = ctx.published
    assert routing_key == MEETING_STITCH
    assert message == MeetingStitchV1(tenant_id=TENANT, meeting_id=MEETING)


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        transcriber.handle_chunk_transcribe(
            {"v": 1, "nope": True}, FakeCtx(), make_deps()
        )


def test_cross_tenant_key_is_rejected(db_calls: DbCalls) -> None:
    bad = payload(r2_key="tenant/other-tenant/meeting/x/chunks/0.flac")
    with pytest.raises(ValueError):
        transcriber.handle_chunk_transcribe(bad, FakeCtx(), make_deps())
    assert db_calls.complete_calls == []


def test_backend_failure_marks_job_failed_and_reraises(db_calls: DbCalls) -> None:
    deps = make_deps()

    class Boom:
        def transcribe(self, _p: Path) -> list[Segment]:
            raise RuntimeError("groq 500")

    deps.backend = Boom()
    with pytest.raises(RuntimeError):
        transcriber.handle_chunk_transcribe(payload(), FakeCtx(), deps)
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:transcribe:0"


def test_any_failure_rolls_back_the_shared_connection(db_calls: DbCalls) -> None:
    conn = FakeConn()
    deps = make_deps(conn=conn)

    class Boom:
        def transcribe(self, _p: Path) -> list[Segment]:
            raise RuntimeError("groq 500")

    deps.backend = Boom()
    with pytest.raises(RuntimeError):
        transcriber.handle_chunk_transcribe(payload(), FakeCtx(), deps)
    assert conn.rollback_calls == 1


def test_worker_survives_a_failed_job_followed_by_a_good_one(db_calls: DbCalls) -> None:
    conn = FakeConn()
    deps = make_deps(conn=conn)

    class Boom:
        def transcribe(self, _p: Path) -> list[Segment]:
            raise RuntimeError("groq 500")

    deps.backend = Boom()
    with pytest.raises(RuntimeError):
        transcriber.handle_chunk_transcribe(payload(), FakeCtx(), deps)

    deps.backend = FakeBackend(parse_verbose_json(FIXTURE))
    ctx = FakeCtx()
    transcriber.handle_chunk_transcribe(payload(), ctx, deps)
    assert len(db_calls.complete_calls) == 1
