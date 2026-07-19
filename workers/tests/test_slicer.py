"""Slicer handler tests (ticket 2.2) — fakes for db, R2, and ffmpeg/ffprobe
(media module) so no real binaries or broker are needed."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import media as media_module
from scribeflow_workers import r2 as r2_module
from scribeflow_workers import slicer
from scribeflow_workers.config import Settings
from scribeflow_workers.framework import PermanentError
from scribeflow_workers.messages import StatusEventV1
from scribeflow_workers.topology import CHUNK_TRANSCRIBE, MEETING_DIARIZE

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"
R2_KEY = f"tenant/{TENANT}/meeting/{MEETING}/audio.mp3"


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "v": 1,
        "tenant_id": TENANT,
        "meeting_id": MEETING,
        "r2_key": R2_KEY,
        "duration_hint_s": None,
    }
    base.update(overrides)
    return base


class FakeCtx:
    def __init__(self) -> None:
        self.events: list[StatusEventV1] = []
        self.published: list[tuple[str, Any]] = []

    def publish_event(self, event: StatusEventV1) -> None:
        self.events.append(event)

    def publish(self, routing_key: str, message: Any) -> None:
        self.published.append((routing_key, message))


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.init_chunk_plan_calls: list[tuple[str, str, int, int]] = []
        self.statuses: list[tuple[str, str | None, int | None]] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []
        self.uploads: list[tuple[str, Path]] = []
        self.sliced: list[tuple[Path, float, float | None]] = []


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()

    monkeypatch.setattr(
        db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result
    )

    def fake_init(conn: Any, t: str, m: str, total_chunks: int, duration_s: int) -> None:
        calls.init_chunk_plan_calls.append((t, m, total_chunks, duration_s))

    monkeypatch.setattr(db_module, "init_chunk_plan", fake_init)
    monkeypatch.setattr(
        db_module,
        "set_meeting_status",
        lambda conn, t, m, status, error=None, duration_s=None: calls.statuses.append(
            (status, error, duration_s)
        ),
    )
    monkeypatch.setattr(
        db_module, "complete_job", lambda conn, key: calls.completed.append(key)
    )
    monkeypatch.setattr(
        db_module, "fail_job", lambda conn, key, error: calls.failed.append((key, error))
    )
    monkeypatch.setattr(
        r2_module, "download", lambda client, bucket, key, dest: dest / "audio.mp3"
    )

    monkeypatch.setattr(
        r2_module,
        "upload",
        lambda client, bucket, key, path: calls.uploads.append((key, path)),
    )

    monkeypatch.setattr(media_module, "probe_duration_s", lambda path: 590.0)

    def fake_slice(src: Path, dest: Path, offset_s: float, duration_s: float | None) -> None:
        calls.sliced.append((dest, offset_s, duration_s))
        dest.write_bytes(b"fake-flac")

    monkeypatch.setattr(media_module, "slice_to_flac", fake_slice)
    return calls


class FakeConn:
    def __init__(self) -> None:
        self.rollback_calls = 0

    def rollback(self) -> None:
        self.rollback_calls += 1


def make_deps(conn: Any = None) -> slicer.Deps:
    return slicer.Deps(
        settings=Settings(), conn=conn if conn is not None else FakeConn(), r2_client=object()
    )


def test_happy_path_slices_uploads_and_publishes_chunk_jobs(db_calls: DbCalls) -> None:
    ctx = FakeCtx()
    slicer.handle_meeting_uploaded(payload(), ctx, make_deps())

    # 590s -> 2 chunks per D46 (see test_chunking.py).
    assert db_calls.init_chunk_plan_calls == [(TENANT, MEETING, 2, 590)]
    assert len(db_calls.sliced) == 2
    assert len(db_calls.uploads) == 2

    chunk_jobs = [m for rk, m in ctx.published if rk == CHUNK_TRANSCRIBE]
    diarize_jobs = [m for rk, m in ctx.published if rk == MEETING_DIARIZE]
    assert len(chunk_jobs) == 2
    assert [j.chunk_idx for j in chunk_jobs] == [0, 1]
    assert all(j.total_chunks == 2 for j in chunk_jobs)
    assert chunk_jobs[1].offset_s == 290.0

    (diarize_job,) = diarize_jobs
    assert diarize_job.r2_key == R2_KEY  # diarizer gets the *original* file

    assert db_calls.statuses == [("transcribing", None, None)]
    assert db_calls.completed == [f"{MEETING}:slice:0"]


def test_redelivered_done_job_is_skipped(db_calls: DbCalls) -> None:
    db_calls.claim_result = False
    ctx = FakeCtx()
    slicer.handle_meeting_uploaded(payload(), ctx, make_deps())
    assert ctx.published == []
    assert db_calls.init_chunk_plan_calls == []


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        slicer.handle_meeting_uploaded({"v": 1, "nope": True}, FakeCtx(), make_deps())


def test_cross_tenant_key_is_rejected(db_calls: DbCalls) -> None:
    bad = payload(r2_key="tenant/other-tenant/meeting/x/audio.mp3")
    with pytest.raises(ValueError):
        slicer.handle_meeting_uploaded(bad, FakeCtx(), make_deps())
    assert db_calls.init_chunk_plan_calls == []


def test_probe_failure_marks_job_failed_and_reraises(
    db_calls: DbCalls, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(path: Path) -> float:
        raise RuntimeError("ffprobe not found")

    monkeypatch.setattr(media_module, "probe_duration_s", boom)
    with pytest.raises(RuntimeError):
        slicer.handle_meeting_uploaded(payload(), FakeCtx(), make_deps())
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:slice:0"


def test_any_failure_rolls_back_the_shared_connection(
    db_calls: DbCalls, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(path: Path) -> float:
        raise RuntimeError("ffprobe not found")

    monkeypatch.setattr(media_module, "probe_duration_s", boom)
    conn = FakeConn()
    with pytest.raises(RuntimeError):
        slicer.handle_meeting_uploaded(payload(), FakeCtx(), make_deps(conn=conn))
    assert conn.rollback_calls == 1


def test_exhausted_hook_marks_meeting_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    deps = make_deps()
    events: list[StatusEventV1] = []

    class Ctx:
        def publish_event(self, event: StatusEventV1) -> None:
            events.append(event)

        def publish(self, routing_key: str, message: Any) -> None:
            raise AssertionError("should not publish jobs on exhaustion")

    calls: list[tuple[str, str, str]] = []

    def fake_fail_if_not_terminal(conn: Any, t: str, m: str, error: str) -> bool:
        calls.append((t, m, error))
        return True

    monkeypatch.setattr(
        db_module, "fail_meeting_if_not_terminal", fake_fail_if_not_terminal
    )
    on_exhausted = slicer.make_on_exhausted(deps)
    on_exhausted(payload(), "ffmpeg crashed", Ctx())

    assert calls == [(TENANT, MEETING, "slicing failed: ffmpeg crashed")]
    assert events[0].status == "failed"


def test_exhausted_hook_does_not_clobber_an_already_terminal_meeting(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Regression (2.8 review): a retry of this slicer job can have already
    # published chunk.transcribe jobs (D15, idempotent) for chunks that
    # went on to complete the whole pipeline through a real stitch before
    # this job's own retries exhaust. fail_meeting_if_not_terminal's False
    # return means the meeting was already done/partial/failed -- publishing
    # a "failed" event here would contradict that already-delivered state.
    deps = make_deps()

    class Ctx:
        def publish_event(self, event: StatusEventV1) -> None:
            raise AssertionError("must not publish a status event")

        def publish(self, routing_key: str, message: Any) -> None:
            raise AssertionError("should not publish jobs on exhaustion")

    monkeypatch.setattr(
        db_module, "fail_meeting_if_not_terminal", lambda conn, t, m, error: False
    )
    on_exhausted = slicer.make_on_exhausted(deps)
    on_exhausted(payload(), "ffmpeg crashed", Ctx())  # must not raise
