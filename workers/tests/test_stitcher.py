"""Stitcher tests (ticket 2.4): the dedup/gap algorithm in isolation (pure
functions, no db), then the full handler with db fakes (no live broker)."""

from __future__ import annotations

from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import stitcher
from scribeflow_workers.chunking import compute_chunk_plan
from scribeflow_workers.config import Settings
from scribeflow_workers.db import StitchInfo, StitchSegmentRow
from scribeflow_workers.framework import PermanentError
from scribeflow_workers.messages import StatusEventV1

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"

# 590s -> exactly 2 chunks (see test_chunking.py): chunk0 [0,300), chunk1
# [290,590) (open-ended), cut point at 295.
TWO_CHUNK_DURATION = 590.0


def seg(id_: str, chunk_idx: int, start_s: float, end_s: float) -> StitchSegmentRow:
    return StitchSegmentRow(id=id_, chunk_idx=chunk_idx, start_s=start_s, end_s=end_s)


# -- pure algorithm: side assignment + cross-cut dedup -----------------------


def test_side_assignment_splits_at_the_cut_midpoint() -> None:
    present = {0, 1}
    segments = [
        seg("a", 0, 100.0, 110.0),  # midpoint 105, well inside chunk0's window
        seg("b", 1, 400.0, 410.0),  # midpoint 405, well inside chunk1's window
    ]
    kept = stitcher._side_assignment_keep(segments, present)
    assert kept == {"a", "b"}


def test_missing_neighbor_disables_the_cut_on_that_side() -> None:
    # chunk1 is missing (exhausted): chunk0 must NOT be trimmed at cut(0)
    # anymore, since there's no neighbor data to dedupe against (this is the
    # refinement over a blind per-cut rule -- see architecture.md's stitching
    # section).
    present = {0, 2}
    segments = [
        seg("late_in_chunk0", 0, 296.0, 299.0),  # midpoint 297.5 > cut(0)=295
    ]
    kept = stitcher._side_assignment_keep(segments, present)
    assert kept == {"late_in_chunk0"}


def test_cross_cut_duplicate_dropped_with_tie_going_to_lower_chunk_index() -> None:
    present = {0, 1}
    offsets = {spec.chunk_idx: spec.offset_s for spec in compute_chunk_plan(TWO_CHUNK_DURATION)}
    segments = [
        seg("a", 0, 100.0, 110.0),
        seg("b0", 0, 291.0, 297.0),  # midpoint 294 < 295: kept on chunk0's side
        seg("b1", 1, 293.0, 299.0),  # midpoint 296 >= 295: kept on chunk1's side
        seg("c", 1, 400.0, 410.0),
    ]
    kept = stitcher._side_assignment_keep(segments, present)
    assert kept == {"a", "b0", "b1", "c"}  # both rule-1 survivors, pre-dedup

    kept = stitcher._dedupe_cross_cut(segments, kept, present, offsets)
    # b0/b1 overlap [293,297] = 4s > 50% of either's 6s duration -> same
    # utterance; edge distances tie (3 vs 3) -> lower chunk index (b0) wins.
    assert kept == {"a", "b0", "c"}


def test_no_dedupe_across_a_missing_middle_chunk() -> None:
    present = {0, 2}
    offsets = {0: 0.0, 2: 580.0}
    segments = [seg("x", 0, 296.0, 299.0), seg("y", 2, 580.0, 585.0)]
    kept = {"x", "y"}
    assert stitcher._dedupe_cross_cut(segments, kept, present, offsets) == {"x", "y"}


# -- pure algorithm: gap computation ------------------------------------------


def test_no_gaps_when_every_chunk_succeeds() -> None:
    plan = compute_chunk_plan(TWO_CHUNK_DURATION)
    gaps = stitcher._compute_gaps(TWO_CHUNK_DURATION, plan, {0, 1})
    assert gaps == []


def test_missing_middle_chunk_leaves_the_uncovered_middle_as_a_gap() -> None:
    duration = 850.0  # 3 chunks: [0,300), [290,580), [580,850) (see below)
    plan = compute_chunk_plan(duration)
    assert [s.chunk_idx for s in plan] == [0, 1, 2]
    gaps = stitcher._compute_gaps(duration, plan, {0, 2})
    assert gaps == [(300.0, 580.0)]


def test_zero_chunks_present_is_one_gap_covering_the_whole_meeting() -> None:
    plan = compute_chunk_plan(TWO_CHUNK_DURATION)
    gaps = stitcher._compute_gaps(TWO_CHUNK_DURATION, plan, set())
    assert gaps == [(0.0, TWO_CHUNK_DURATION)]


# -- handler ------------------------------------------------------------------


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"v": 1, "tenant_id": TENANT, "meeting_id": MEETING}
    base.update(overrides)
    return base


class FakeCtx:
    def __init__(self) -> None:
        self.events: list[StatusEventV1] = []

    def publish_event(self, event: StatusEventV1) -> None:
        self.events.append(event)

    def publish(self, routing_key: str, message: Any) -> None:
        raise AssertionError("the stitcher never publishes downstream jobs")


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.stitch_info = StitchInfo(
            duration_s=TWO_CHUNK_DURATION, total_chunks=2, diarization_error=None
        )
        self.chunk_statuses: dict[int, str] = {0: "done", 1: "done"}
        self.segments: list[StitchSegmentRow] = []
        self.speaker_turns: list[tuple[str, float, float]] = []
        self.finalizations: list[db_module.StitchFinalization] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()
    monkeypatch.setattr(
        db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result
    )
    monkeypatch.setattr(db_module, "get_stitch_info", lambda conn, m: calls.stitch_info)
    monkeypatch.setattr(
        db_module, "get_chunk_statuses", lambda conn, m: calls.chunk_statuses
    )
    monkeypatch.setattr(
        db_module, "get_segments_for_stitch", lambda conn, m: calls.segments
    )
    monkeypatch.setattr(
        db_module,
        "get_speaker_turns_for_stitch",
        lambda conn, m: calls.speaker_turns,
    )

    def fake_finalize(conn: Any, finalization: db_module.StitchFinalization) -> None:
        calls.finalizations.append(finalization)

    monkeypatch.setattr(db_module, "finalize_stitch", fake_finalize)
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


def make_deps(conn: Any = None) -> stitcher.Deps:
    return stitcher.Deps(settings=Settings(), conn=conn if conn is not None else FakeConn())


def test_all_chunks_done_no_gaps_finalizes_done(db_calls: DbCalls) -> None:
    db_calls.segments = [
        seg("a", 0, 100.0, 110.0),
        seg("b0", 0, 291.0, 297.0),
        seg("b1", 1, 293.0, 299.0),
        seg("c", 1, 400.0, 410.0),
    ]
    ctx = FakeCtx()
    stitcher.handle_meeting_stitch(payload(), ctx, make_deps())

    (finalization,) = db_calls.finalizations
    assert finalization.status == "done"
    assert finalization.gaps == []
    assert finalization.drop_segment_ids == ["b1"]
    assert finalization.error is None
    # No speaker_turns rows in this test: every surviving segment gets an
    # explicit None assignment (2.6) rather than being left out.
    assert finalization.speaker_assignments == {"a": None, "b0": None, "c": None}
    assert finalization.speaker_defaults == {}
    assert ctx.events[0].status == "done"
    assert db_calls.completed == [f"{MEETING}:stitch:0"]


def test_speaker_merge_assigns_max_overlap_label_to_surviving_segments(
    db_calls: DbCalls,
) -> None:
    db_calls.segments = [seg("a", 0, 100.0, 110.0), seg("b1", 1, 293.0, 299.0)]
    db_calls.speaker_turns = [
        ("SPEAKER_00", 95.0, 105.0),  # 5s overlap with "a"
        ("SPEAKER_01", 105.0, 115.0),  # 5s overlap with "a" -- tie -> SPEAKER_00
        ("SPEAKER_01", 290.0, 300.0),  # fully covers "b1"
    ]
    ctx = FakeCtx()
    stitcher.handle_meeting_stitch(payload(), ctx, make_deps())

    (finalization,) = db_calls.finalizations
    assert finalization.speaker_assignments == {"a": "SPEAKER_00", "b1": "SPEAKER_01"}
    # Default names numbered by first turn start: SPEAKER_00's first turn
    # (95.0) precedes SPEAKER_01's (105.0), so SPEAKER_00 is "Speaker 1".
    assert finalization.speaker_defaults == {
        "SPEAKER_00": "Speaker 1",
        "SPEAKER_01": "Speaker 2",
    }


def test_dropped_segment_gets_no_speaker_assignment(db_calls: DbCalls) -> None:
    # b1 is the cross-cut duplicate loser (same fixture as the pure dedup
    # test above) -- it must not appear in speaker_assignments even though a
    # turn overlaps it, since the merge only runs over the kept set.
    db_calls.segments = [
        seg("a", 0, 100.0, 110.0),
        seg("b0", 0, 291.0, 297.0),
        seg("b1", 1, 293.0, 299.0),
        seg("c", 1, 400.0, 410.0),
    ]
    db_calls.speaker_turns = [("SPEAKER_00", 290.0, 300.0)]
    stitcher.handle_meeting_stitch(payload(), FakeCtx(), make_deps())

    (finalization,) = db_calls.finalizations
    assert "b1" not in finalization.speaker_assignments
    assert finalization.speaker_assignments["b0"] == "SPEAKER_00"


def test_exhausted_middle_chunk_finalizes_partial_with_a_gap(db_calls: DbCalls) -> None:
    db_calls.stitch_info = StitchInfo(duration_s=850.0, total_chunks=3, diarization_error=None)
    db_calls.chunk_statuses = {0: "done", 1: "exhausted", 2: "done"}
    db_calls.segments = [seg("x", 0, 296.0, 299.0), seg("y", 2, 580.0, 585.0)]
    ctx = FakeCtx()
    stitcher.handle_meeting_stitch(payload(), ctx, make_deps())

    (finalization,) = db_calls.finalizations
    assert finalization.status == "partial"
    assert finalization.gaps == [(300.0, 580.0)]
    assert finalization.drop_segment_ids == []  # no dedup across the missing chunk
    assert ctx.events[0].status == "partial"


def test_every_chunk_exhausted_finalizes_failed(db_calls: DbCalls) -> None:
    db_calls.chunk_statuses = {0: "exhausted", 1: "exhausted"}
    db_calls.segments = []
    ctx = FakeCtx()
    stitcher.handle_meeting_stitch(payload(), ctx, make_deps())

    (finalization,) = db_calls.finalizations
    assert finalization.status == "failed"


def test_diarization_error_forces_partial_even_with_no_gaps(db_calls: DbCalls) -> None:
    db_calls.stitch_info = StitchInfo(
        duration_s=TWO_CHUNK_DURATION, total_chunks=2, diarization_error="pyannote OOM"
    )
    db_calls.segments = []
    ctx = FakeCtx()
    stitcher.handle_meeting_stitch(payload(), ctx, make_deps())

    (finalization,) = db_calls.finalizations
    assert finalization.status == "partial"
    assert finalization.error == "pyannote OOM"


def test_redelivered_done_job_is_skipped(db_calls: DbCalls) -> None:
    db_calls.claim_result = False
    stitcher.handle_meeting_stitch(payload(), FakeCtx(), make_deps())
    assert db_calls.finalizations == []


def test_invalid_message_is_permanent(db_calls: DbCalls) -> None:
    with pytest.raises(PermanentError):
        stitcher.handle_meeting_stitch({"v": 1, "nope": True}, FakeCtx(), make_deps())


def test_stitch_failure_marks_job_failed_and_reraises(
    db_calls: DbCalls, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(conn: Any, m: str) -> StitchInfo:
        raise RuntimeError("db down")

    monkeypatch.setattr(db_module, "get_stitch_info", boom)
    with pytest.raises(RuntimeError):
        stitcher.handle_meeting_stitch(payload(), FakeCtx(), make_deps())
    assert db_calls.failed and db_calls.failed[0][0] == f"{MEETING}:stitch:0"


def test_any_failure_rolls_back_the_shared_connection(
    db_calls: DbCalls, monkeypatch: pytest.MonkeyPatch
) -> None:
    def boom(conn: Any, m: str) -> StitchInfo:
        raise RuntimeError("db down")

    monkeypatch.setattr(db_module, "get_stitch_info", boom)
    conn = FakeConn()
    with pytest.raises(RuntimeError):
        stitcher.handle_meeting_stitch(payload(), FakeCtx(), make_deps(conn=conn))
    assert conn.rollback_calls == 1


def test_exhausted_hook_marks_meeting_failed(monkeypatch: pytest.MonkeyPatch) -> None:
    deps = make_deps()
    events: list[StatusEventV1] = []
    statuses: list[tuple[str, str | None]] = []
    monkeypatch.setattr(
        db_module,
        "set_meeting_status",
        lambda conn, t, m, status, error=None, duration_s=None: statuses.append(
            (status, error)
        ),
    )

    class Ctx:
        def publish_event(self, event: StatusEventV1) -> None:
            events.append(event)

    on_exhausted = stitcher.make_on_exhausted(deps)
    on_exhausted(payload(), "stitcher bug", Ctx())

    assert statuses[0][0] == "failed"
    assert events[0].status == "failed"
