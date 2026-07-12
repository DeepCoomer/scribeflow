"""Transcriber handler tests — full handler flow with fakes for the db, R2,
and backend (recorded Groq fixture; no live calls per CLAUDE.md)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import r2 as r2_module
from scribeflow_workers import transcriber
from scribeflow_workers.config import Settings
from scribeflow_workers.db import SegmentRow
from scribeflow_workers.framework import PermanentError
from scribeflow_workers.messages import StatusEventV1
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
        "r2_key": f"tenant/{TENANT}/meeting/{MEETING}/audio.mp3",
        "duration_hint_s": None,
    }
    base.update(overrides)
    return base


class FakeCtx:
    def __init__(self) -> None:
        self.events: list[StatusEventV1] = []

    def publish_event(self, event: StatusEventV1) -> None:
        self.events.append(event)


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
        self.statuses: list[tuple[str, str | None, int | None]] = []
        self.segments: list[SegmentRow] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()

    monkeypatch.setattr(
        db_module,
        "claim_job",
        lambda conn, t, m, k, s: calls.claim_result,
    )
    monkeypatch.setattr(
        db_module,
        "set_meeting_status",
        lambda conn, t, m, status, error=None, duration_s=None: calls.statuses.append(
            (status, error, duration_s)
        ),
    )

    def fake_replace(
        conn: Any, t: str, m: str, chunk_idx: int, rows: list[SegmentRow]
    ) -> None:
        assert (t, m, chunk_idx) == (TENANT, MEETING, 0)
        calls.segments = rows

    monkeypatch.setattr(db_module, "replace_segments", fake_replace)
    monkeypatch.setattr(
        db_module, "complete_job", lambda conn, key: calls.completed.append(key)
    )
    monkeypatch.setattr(
        db_module,
        "fail_job",
        lambda conn, key, error: calls.failed.append((key, error)),
    )
    monkeypatch.setattr(
        r2_module,
        "download",
        lambda client, bucket, key, dest: dest / "audio.mp3",
    )
    return calls


def make_deps() -> transcriber.Deps:
    return transcriber.Deps(
        settings=Settings(),
        conn=object(),
        backend=FakeBackend(parse_verbose_json(FIXTURE)),
        r2_client=object(),
        rate_limited=False,
    )


def test_fixture_parses_and_drops_silence() -> None:
    segments = parse_verbose_json(FIXTURE)
    assert [s.text for s in segments] == [
        "Welcome everyone, let's get started.",
        "First item is the Q3 roadmap.",
        "Sounds good, I'll take notes.",
    ]
    assert segments[0].start_s == 0.0
    assert segments[-1].end_s == 21.48


def test_happy_path_writes_segments_and_transitions(db_calls: DbCalls) -> None:
    ctx = FakeCtx()
    transcriber.handle_meeting_uploaded(payload(), ctx, make_deps())

    assert [s[0] for s in db_calls.statuses] == ["transcribing", "done"]
    assert db_calls.statuses[-1][2] == 21  # duration from last segment end
    assert len(db_calls.segments) == 3
    assert db_calls.completed == [f"{MEETING}:transcribe:0"]
    assert [e.status for e in ctx.events] == ["transcribing", "done"]
    assert all(e.tenant_id == TENANT for e in ctx.events)


def test_redelivered_done_job_is_skipped(db_calls: DbCalls) -> None:
    db_calls.claim_result = False
    ctx = FakeCtx()
    transcriber.handle_meeting_uploaded(payload(), ctx, make_deps())
    assert db_calls.statuses == []
    assert ctx.events == []


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        transcriber.handle_meeting_uploaded(
            {"v": 1, "nope": True}, FakeCtx(), make_deps()
        )


def test_cross_tenant_key_is_rejected(db_calls: DbCalls) -> None:
    bad = payload(r2_key="tenant/other-tenant/meeting/x/audio.mp3")
    with pytest.raises(ValueError):
        transcriber.handle_meeting_uploaded(bad, FakeCtx(), make_deps())
    # The failure happened before any transcription work or status change.
    assert db_calls.segments == []


def test_backend_failure_marks_job_failed_and_reraises(db_calls: DbCalls) -> None:
    deps = make_deps()

    class Boom:
        def transcribe(self, _p: Path) -> list[Segment]:
            raise RuntimeError("groq 500")

    deps.backend = Boom()
    with pytest.raises(RuntimeError):
        transcriber.handle_meeting_uploaded(payload(), FakeCtx(), deps)
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:transcribe:0"
