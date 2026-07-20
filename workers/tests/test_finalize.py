"""meeting.finalize handler tests (ticket 5.3, D69) — same fake-everything
approach as test_slicer.py: no real ffmpeg/R2/broker needed."""

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
from scribeflow_workers.messages import PipelineEventV1
from scribeflow_workers.r2 import BotSegmentObject
from scribeflow_workers.topology import MEETING_UPLOADED

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "v": 1,
        "type": "meeting.finalize",
        "tenant_id": TENANT,
        "meeting_id": MEETING,
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


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.r2_keys: list[tuple[str, str, str]] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []


class FakeConn:
    def __init__(self) -> None:
        self.rollback_calls = 0

    def rollback(self) -> None:
        self.rollback_calls += 1


def make_deps(conn: Any = None) -> slicer.Deps:
    return slicer.Deps(
        settings=Settings(), conn=conn if conn is not None else FakeConn(), r2_client=object()
    )


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()
    monkeypatch.setattr(db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result)
    monkeypatch.setattr(
        db_module,
        "set_meeting_r2_key",
        lambda conn, t, m, key: calls.r2_keys.append((t, m, key)),
    )
    monkeypatch.setattr(
        db_module, "complete_job", lambda conn, key: calls.completed.append(key)
    )
    monkeypatch.setattr(
        db_module, "fail_job", lambda conn, key, error: calls.failed.append((key, error))
    )
    return calls


def fake_segments(*, gap_before_last_ms: int | None = None) -> list[BotSegmentObject]:
    """Three consecutive 300s segments, all uploaded back to back — no real
    gap. If gap_before_last_ms is given, the third segment's started_at_ms is
    pushed out by that much (simulating a crash + rejoin)."""
    seg0 = BotSegmentObject(key=f"tenant/{TENANT}/meeting/{MEETING}/bot-segments/0_1000.ogg", idx=0, started_at_ms=1_000)
    seg1 = BotSegmentObject(
        key=f"tenant/{TENANT}/meeting/{MEETING}/bot-segments/1_301000.ogg", idx=1, started_at_ms=301_000
    )
    # Exactly contiguous with seg1 (300s start + 300s duration = 601_000ms)
    # unless a gap is requested on top of that.
    third_start = 601_000 + (gap_before_last_ms or 0)
    seg2 = BotSegmentObject(
        key=f"tenant/{TENANT}/meeting/{MEETING}/bot-segments/2_{third_start}.ogg",
        idx=2,
        started_at_ms=third_start,
    )
    return [seg0, seg1, seg2]


@pytest.fixture()
def media_fakes(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    calls: dict[str, list[Any]] = {"downloads": [], "silence": [], "concat": [], "uploads": []}

    def fake_download(client: Any, bucket: str, key: str, dest: Path) -> Path:
        calls["downloads"].append(key)
        return dest / Path(key).name

    def fake_generate_silence(dest: Path, duration_s: float) -> None:
        calls["silence"].append((dest, duration_s))
        dest.write_bytes(b"silence")

    def fake_concat_audio(inputs: list[Path], dest: Path) -> None:
        calls["concat"].append(list(inputs))
        dest.write_bytes(b"final")

    def fake_upload(client: Any, bucket: str, key: str, path: Path) -> None:
        calls["uploads"].append(key)

    monkeypatch.setattr(r2_module, "download", fake_download)
    monkeypatch.setattr(media_module, "probe_duration_s", lambda path: 300.0)
    monkeypatch.setattr(media_module, "generate_silence", fake_generate_silence)
    monkeypatch.setattr(media_module, "concat_audio", fake_concat_audio)
    monkeypatch.setattr(r2_module, "upload", fake_upload)
    return calls


def test_happy_path_concatenates_without_padding_when_segments_are_contiguous(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        r2_module, "list_bot_segments", lambda client, bucket, t, m: fake_segments()
    )
    ctx = FakeCtx()
    slicer.handle_meeting_finalize(payload(), ctx, make_deps())

    assert len(media_fakes["downloads"]) == 3
    assert media_fakes["silence"] == []  # no gap -> no padding inserted
    assert len(media_fakes["concat"][0]) == 3  # just the three real segments

    (r2_key,) = media_fakes["uploads"]
    assert r2_key == f"tenant/{TENANT}/meeting/{MEETING}/recording.ogg"
    assert db_calls.r2_keys == [(TENANT, MEETING, r2_key)]

    uploaded_jobs = [m for rk, m in ctx.published if rk == MEETING_UPLOADED]
    assert len(uploaded_jobs) == 1
    assert uploaded_jobs[0].tenant_id == TENANT
    assert uploaded_jobs[0].meeting_id == MEETING
    assert uploaded_jobs[0].r2_key == r2_key
    # 3 segments x 300s, contiguous -> 900s total.
    assert uploaded_jobs[0].duration_hint_s == pytest.approx(900.0)
    assert db_calls.completed == [f"{MEETING}:finalize:0"]


def test_inserts_silence_for_a_wall_clock_gap_from_a_crash_and_rejoin(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    # A 5-minute hole between segment 1 ending and segment 2 starting.
    monkeypatch.setattr(
        r2_module,
        "list_bot_segments",
        lambda client, bucket, t, m: fake_segments(gap_before_last_ms=300_000),
    )
    ctx = FakeCtx()
    slicer.handle_meeting_finalize(payload(), ctx, make_deps())

    assert len(media_fakes["silence"]) == 1
    (_, gap_s) = media_fakes["silence"][0]
    assert gap_s == pytest.approx(300.0)
    # Real segment, real segment, silence, real segment.
    assert len(media_fakes["concat"][0]) == 4

    uploaded_jobs = [m for rk, m in ctx.published if rk == MEETING_UPLOADED]
    # 900s of real audio + 300s of padding = 1200s total, absolute timeline.
    assert uploaded_jobs[0].duration_hint_s == pytest.approx(1200.0)


def test_small_jitter_below_the_epsilon_is_not_padded(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        r2_module,
        "list_bot_segments",
        lambda client, bucket, t, m: fake_segments(gap_before_last_ms=50),
    )
    ctx = FakeCtx()
    slicer.handle_meeting_finalize(payload(), ctx, make_deps())
    assert media_fakes["silence"] == []


def test_redelivered_done_job_is_skipped(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    db_calls.claim_result = False
    monkeypatch.setattr(
        r2_module, "list_bot_segments", lambda client, bucket, t, m: fake_segments()
    )
    ctx = FakeCtx()
    slicer.handle_meeting_finalize(payload(), ctx, make_deps())
    assert ctx.published == []
    assert media_fakes["downloads"] == []


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        slicer.handle_meeting_finalize({"v": 1, "type": "meeting.finalize"}, FakeCtx(), make_deps())


def test_no_segments_found_is_permanent_not_retried(
    db_calls: DbCalls, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(r2_module, "list_bot_segments", lambda client, bucket, t, m: [])
    with pytest.raises(PermanentError):
        slicer.handle_meeting_finalize(payload(), FakeCtx(), make_deps())


def test_concat_failure_marks_job_failed_and_reraises(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        r2_module, "list_bot_segments", lambda client, bucket, t, m: fake_segments()
    )

    def boom(inputs: list[Path], dest: Path) -> None:
        raise RuntimeError("ffmpeg concat failed")

    monkeypatch.setattr(media_module, "concat_audio", boom)
    with pytest.raises(RuntimeError):
        slicer.handle_meeting_finalize(payload(), FakeCtx(), make_deps())
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:finalize:0"


def test_any_failure_rolls_back_the_shared_connection(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        r2_module, "list_bot_segments", lambda client, bucket, t, m: fake_segments()
    )

    def boom(inputs: list[Path], dest: Path) -> None:
        raise RuntimeError("ffmpeg concat failed")

    monkeypatch.setattr(media_module, "concat_audio", boom)
    conn = FakeConn()
    with pytest.raises(RuntimeError):
        slicer.handle_meeting_finalize(payload(), FakeCtx(), make_deps(conn=conn))
    assert conn.rollback_calls == 1


def test_dispatch_routes_finalize_messages_to_the_finalize_handler(
    db_calls: DbCalls, media_fakes: dict[str, list[Any]], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The q.slicer worker consumes both meeting.uploaded and
    meeting.finalize off one queue (D69); this exercises main()'s dispatch
    logic directly rather than duplicating it."""
    monkeypatch.setattr(
        r2_module, "list_bot_segments", lambda client, bucket, t, m: fake_segments()
    )
    deps = make_deps()

    def handler(p: dict[str, Any], ctx: Any) -> None:
        if p.get("type") == "meeting.finalize":
            slicer.handle_meeting_finalize(p, ctx, deps)
        else:
            raise AssertionError("should have dispatched to the finalize handler")

    ctx = FakeCtx()
    handler(payload(), ctx)
    assert db_calls.completed == [f"{MEETING}:finalize:0"]
