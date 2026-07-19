"""Diarizer handler tests (ticket 2.5) — fake DiarizeBackend, so no torch or
pyannote install (or HF download) is needed to exercise the handler."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import diarizer
from scribeflow_workers import r2 as r2_module
from scribeflow_workers.config import Settings
from scribeflow_workers.db import FanIn
from scribeflow_workers.diarize_backends import SpeakerTurn
from scribeflow_workers.framework import PermanentError
from scribeflow_workers.messages import MeetingStitchV1, PipelineEventV1
from scribeflow_workers.topology import MEETING_STITCH

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"
R2_KEY = f"tenant/{TENANT}/meeting/{MEETING}/audio.mp3"


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "v": 1,
        "tenant_id": TENANT,
        "meeting_id": MEETING,
        "r2_key": R2_KEY,
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
    def __init__(self, turns: list[SpeakerTurn]) -> None:
        self._turns = turns

    def diarize(self, audio_path: Path) -> list[SpeakerTurn]:
        return self._turns


TURNS = [
    SpeakerTurn(speaker="SPEAKER_00", start_s=0.0, end_s=12.0),
    SpeakerTurn(speaker="SPEAKER_01", start_s=12.0, end_s=30.0),
]


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.inserted_turns: list[tuple[str, list[tuple[str, float, float]]]] = []
        self.diarization_done: list[tuple[str, str, str | None]] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.fan_in_result = FanIn(
            chunks_done=3, total_chunks=3, diarization_done=True, status="transcribing"
        )


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()
    monkeypatch.setattr(
        db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result
    )

    def fake_insert(conn: Any, m: str, turns: list[tuple[str, float, float]]) -> None:
        calls.inserted_turns.append((m, turns))

    monkeypatch.setattr(db_module, "insert_speaker_turns", fake_insert)

    def fake_set_done(conn: Any, t: str, m: str, error: str | None = None) -> None:
        calls.diarization_done.append((t, m, error))

    monkeypatch.setattr(db_module, "set_diarization_done", fake_set_done)
    monkeypatch.setattr(
        db_module, "complete_job", lambda conn, key: calls.completed.append(key)
    )
    monkeypatch.setattr(
        db_module, "fail_job", lambda conn, key, error: calls.failed.append((key, error))
    )
    monkeypatch.setattr(db_module, "get_fan_in", lambda conn, m: calls.fan_in_result)
    monkeypatch.setattr(
        r2_module, "download", lambda client, bucket, key, dest: dest / "audio.mp3"
    )
    return calls


class FakeConn:
    def __init__(self) -> None:
        self.rollback_calls = 0

    def rollback(self) -> None:
        self.rollback_calls += 1


def make_deps(conn: Any = None) -> diarizer.Deps:
    return diarizer.Deps(
        settings=Settings(),
        conn=conn if conn is not None else FakeConn(),
        backend=FakeBackend(TURNS),
        r2_client=object(),
    )


def test_happy_path_stores_turns_and_marks_done(db_calls: DbCalls) -> None:
    ctx = FakeCtx()
    diarizer.handle_meeting_diarize(payload(), ctx, make_deps())

    (call,) = db_calls.inserted_turns
    meeting_id, turns = call
    assert meeting_id == MEETING
    assert turns == [("SPEAKER_00", 0.0, 12.0), ("SPEAKER_01", 12.0, 30.0)]
    assert db_calls.diarization_done == [(TENANT, MEETING, None)]
    assert db_calls.completed == [f"{MEETING}:diarize:0"]


def test_triggers_stitch_when_racing_branch_already_closed(db_calls: DbCalls) -> None:
    ctx = FakeCtx()
    diarizer.handle_meeting_diarize(payload(), ctx, make_deps())

    ((routing_key, message),) = ctx.published
    assert routing_key == MEETING_STITCH
    assert message == MeetingStitchV1(tenant_id=TENANT, meeting_id=MEETING)


def test_does_not_trigger_stitch_when_chunks_still_in_flight(db_calls: DbCalls) -> None:
    db_calls.fan_in_result = FanIn(
        chunks_done=1, total_chunks=3, diarization_done=True, status="transcribing"
    )
    ctx = FakeCtx()
    diarizer.handle_meeting_diarize(payload(), ctx, make_deps())
    assert ctx.published == []


def test_redelivered_done_job_rechecks_fan_in(db_calls: DbCalls) -> None:
    db_calls.claim_result = False
    ctx = FakeCtx()
    diarizer.handle_meeting_diarize(payload(), ctx, make_deps())

    assert db_calls.inserted_turns == []
    ((routing_key, message),) = ctx.published
    assert routing_key == MEETING_STITCH
    assert message == MeetingStitchV1(tenant_id=TENANT, meeting_id=MEETING)


def test_redelivered_done_job_does_not_republish_once_already_stitched(
    db_calls: DbCalls,
) -> None:
    # Regression (2.8 review): a duplicate meeting.diarize arriving after
    # the meeting was already stitched must not republish meeting.stitch --
    # chunks_done/diarization_done stay true forever once set, so without
    # checking status this would fire on every future redelivery.
    db_calls.claim_result = False
    db_calls.fan_in_result = FanIn(
        chunks_done=3, total_chunks=3, diarization_done=True, status="done"
    )
    ctx = FakeCtx()
    diarizer.handle_meeting_diarize(payload(), ctx, make_deps())
    assert ctx.published == []


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        diarizer.handle_meeting_diarize({"v": 1, "nope": True}, FakeCtx(), make_deps())


def test_cross_tenant_key_is_rejected(db_calls: DbCalls) -> None:
    bad = payload(r2_key="tenant/other-tenant/meeting/x/audio.mp3")
    with pytest.raises(ValueError):
        diarizer.handle_meeting_diarize(bad, FakeCtx(), make_deps())
    assert db_calls.inserted_turns == []


def test_backend_failure_marks_job_failed_and_reraises(db_calls: DbCalls) -> None:
    deps = make_deps()

    class Boom:
        def diarize(self, _p: Path) -> list[SpeakerTurn]:
            raise RuntimeError("pyannote crashed")

    deps.backend = Boom()
    with pytest.raises(RuntimeError):
        diarizer.handle_meeting_diarize(payload(), FakeCtx(), deps)
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:diarize:0"


def test_any_failure_rolls_back_the_shared_connection(db_calls: DbCalls) -> None:
    conn = FakeConn()
    deps = make_deps(conn=conn)

    class Boom:
        def diarize(self, _p: Path) -> list[SpeakerTurn]:
            raise RuntimeError("pyannote crashed")

    deps.backend = Boom()
    with pytest.raises(RuntimeError):
        diarizer.handle_meeting_diarize(payload(), FakeCtx(), deps)
    assert conn.rollback_calls == 1


def test_exhausted_hook_marks_diarization_done_with_error_and_can_trigger_stitch(
    db_calls: DbCalls,
) -> None:
    ctx = FakeCtx()
    on_exhausted = diarizer.make_on_exhausted(make_deps())
    on_exhausted(payload(), "pyannote OOM", ctx)

    assert db_calls.diarization_done == [(TENANT, MEETING, "pyannote OOM")]
    ((routing_key, message),) = ctx.published
    assert routing_key == MEETING_STITCH
    assert message == MeetingStitchV1(tenant_id=TENANT, meeting_id=MEETING)
