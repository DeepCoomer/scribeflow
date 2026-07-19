"""Pipeline chaos tests (ticket 2.7): three failure modes the racing engine
must survive per architecture.md/D50 -- a worker dying mid-chunk before it
ever writes, RabbitMQ's at-least-once redelivery of a chunk that already
committed, and the racing/diarization branches finishing in scrambled order.

Unlike the per-worker tests (test_transcriber.py, test_diarizer.py,
test_stitcher.py), which mock each db.py call independently per test, these
wire the *real* transcriber/diarizer/stitcher handlers to one shared
in-memory `FakeDb` across multiple handler invocations, so the exactly-once
counter semantics (D14/D50) and idempotent stitch (D11) are exercised the
same way a live Postgres + RabbitMQ would exercise them -- just with the
"chaos" (crash timing, duplication, ordering) chosen by the test instead of
left to chance. No live broker/Postgres, per CLAUDE.md's fixture-only rule.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import diarizer, stitcher, transcriber
from scribeflow_workers import r2 as r2_module
from scribeflow_workers.chunking import compute_chunk_plan
from scribeflow_workers.config import Settings
from scribeflow_workers.diarize_backends import SpeakerTurn as BackendSpeakerTurn
from scribeflow_workers.messages import PipelineEventV1
from scribeflow_workers.topology import MEETING_STITCH
from scribeflow_workers.transcribe_backends import Segment

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"


# -- shared plumbing: one in-memory "database" wired to the real handlers ----


@dataclass
class FakeMeeting:
    total_chunks: int
    duration_s: float
    chunks_done: int = 0
    diarization_done: bool = False
    diarization_error: str | None = None
    status: str = "transcribing"
    error: str | None = None


class FakeDb:
    """Reproduces the exactly-once transition db.py's real SQL gives
    (`UPDATE ... WHERE status <> ... RETURNING`, D14/D50) with plain dicts,
    so redelivery/duplicate/out-of-order chaos plays out against the same
    invariant a live Postgres connection would enforce."""

    def __init__(self, total_chunks: int, duration_s: float) -> None:
        self.meeting = FakeMeeting(total_chunks=total_chunks, duration_s=duration_s)
        self.jobs: dict[str, str] = {}
        self.segments: dict[int, list[db_module.SegmentRow]] = {}
        self.speaker_turns: list[tuple[str, float, float]] = []
        self.meeting_speakers: dict[str, str] = {}
        self.finalizations: list[db_module.StitchFinalization] = []

    # -- job ledger --------------------------------------------------------
    def claim_job(
        self, conn: Any, tenant_id: str, meeting_id: str, job_key: str, stage: str
    ) -> bool:
        return self.jobs.get(job_key) != "done"

    def fail_job(self, conn: Any, job_key: str, error: str) -> None:
        self.jobs[job_key] = "failed"

    def complete_job(self, conn: Any, job_key: str) -> None:
        self.jobs[job_key] = "done"

    # -- chunk fan-in (D14/D50) ---------------------------------------------
    def _transition_and_count(
        self, job_key: str, terminal_status: str
    ) -> tuple[bool, int, int]:
        transitioned = self.jobs.get(job_key) != terminal_status
        if transitioned:
            self.jobs[job_key] = terminal_status
            self.meeting.chunks_done += 1
        return transitioned, self.meeting.chunks_done, self.meeting.total_chunks

    def complete_chunk_job(
        self,
        conn: Any,
        tenant_id: str,
        meeting_id: str,
        chunk_idx: int,
        job_key: str,
        segments: list[db_module.SegmentRow],
    ) -> db_module.ChunkCompletion:
        self.segments[chunk_idx] = segments
        transitioned, done, total = self._transition_and_count(job_key, "done")
        return db_module.ChunkCompletion(transitioned, done, total)

    def exhaust_chunk_job(
        self, conn: Any, meeting_id: str, job_key: str
    ) -> db_module.ChunkCompletion:
        transitioned, done, total = self._transition_and_count(job_key, "exhausted")
        return db_module.ChunkCompletion(transitioned, done, total)

    def get_fan_in(self, conn: Any, meeting_id: str) -> db_module.FanIn:
        m = self.meeting
        return db_module.FanIn(
            m.chunks_done, m.total_chunks, m.diarization_done, m.status
        )

    def job_exists(self, conn: Any, job_key: str) -> bool:
        return job_key in self.jobs

    def get_chunk_statuses(self, conn: Any, meeting_id: str) -> dict[int, str]:
        prefix = f"{meeting_id}:transcribe:"
        return {
            int(key[len(prefix) :]): status
            for key, status in self.jobs.items()
            if key.startswith(prefix)
        }

    # -- diarization ---------------------------------------------------------
    def set_diarization_done(
        self, conn: Any, tenant_id: str, meeting_id: str, error: str | None = None
    ) -> None:
        self.meeting.diarization_done = True
        self.meeting.diarization_error = error

    def insert_speaker_turns(
        self, conn: Any, meeting_id: str, turns: list[tuple[str, float, float]]
    ) -> None:
        self.speaker_turns = list(turns)

    def get_speaker_turns_for_stitch(
        self, conn: Any, meeting_id: str
    ) -> list[tuple[str, float, float]]:
        return self.speaker_turns

    # -- stitch ---------------------------------------------------------------
    def get_stitch_info(self, conn: Any, meeting_id: str) -> db_module.StitchInfo:
        return db_module.StitchInfo(
            duration_s=self.meeting.duration_s,
            total_chunks=self.meeting.total_chunks,
            diarization_error=self.meeting.diarization_error,
        )

    def get_segments_for_stitch(
        self, conn: Any, meeting_id: str
    ) -> list[db_module.StitchSegmentRow]:
        rows: list[db_module.StitchSegmentRow] = []
        for chunk_idx, segs in self.segments.items():
            for i, seg in enumerate(segs):
                rows.append(
                    db_module.StitchSegmentRow(
                        id=f"{chunk_idx}:{i}",
                        chunk_idx=chunk_idx,
                        start_s=seg.start_s,
                        end_s=seg.end_s,
                    )
                )
        return rows

    def finalize_stitch(
        self, conn: Any, finalization: db_module.StitchFinalization
    ) -> None:
        self.finalizations.append(finalization)
        self.meeting.status = finalization.status
        self.meeting.error = finalization.error
        for label, name in finalization.speaker_defaults.items():
            self.meeting_speakers.setdefault(label, name)  # ON CONFLICT DO NOTHING


DB_METHODS = [
    "claim_job",
    "fail_job",
    "complete_job",
    "complete_chunk_job",
    "exhaust_chunk_job",
    "get_fan_in",
    "job_exists",
    "get_chunk_statuses",
    "set_diarization_done",
    "insert_speaker_turns",
    "get_speaker_turns_for_stitch",
    "get_stitch_info",
    "get_segments_for_stitch",
    "finalize_stitch",
]


def wire_fake_db(monkeypatch: pytest.MonkeyPatch, fake: FakeDb) -> None:
    for name in DB_METHODS:
        monkeypatch.setattr(db_module, name, getattr(fake, name))
    monkeypatch.setattr(
        r2_module, "download", lambda client, bucket, key, dest: dest / "audio"
    )


class RecordingCtx:
    def __init__(self) -> None:
        self.events: list[PipelineEventV1] = []
        self.published: list[tuple[str, Any]] = []

    def publish_event(self, event: PipelineEventV1) -> None:
        self.events.append(event)

    def publish(self, routing_key: str, message: Any) -> None:
        self.published.append((routing_key, message))


class FakeConn:
    def rollback(self) -> None:
        pass


def transcribe_payload(
    chunk_idx: int, total_chunks: int, offset_s: float
) -> dict[str, Any]:
    return {
        "v": 1,
        "tenant_id": TENANT,
        "meeting_id": MEETING,
        "chunk_idx": chunk_idx,
        "total_chunks": total_chunks,
        "offset_s": offset_s,
        "r2_key": f"tenant/{TENANT}/meeting/{MEETING}/chunks/{chunk_idx}.flac",
    }


def diarize_payload() -> dict[str, Any]:
    return {
        "v": 1,
        "tenant_id": TENANT,
        "meeting_id": MEETING,
        "r2_key": f"tenant/{TENANT}/meeting/{MEETING}/audio.mp3",
    }


def stitch_payload() -> dict[str, Any]:
    return {"v": 1, "tenant_id": TENANT, "meeting_id": MEETING}


class ScriptedBackend:
    """A transcribe backend whose transcribe() outcome is scripted call by
    call -- exceptions model a worker dying mid-chunk before any write."""

    def __init__(self, outcomes: list[Exception | list[Segment]]) -> None:
        self._outcomes = list(outcomes)
        self.calls = 0

    def transcribe(self, audio_path: Path) -> list[Segment]:
        self.calls += 1
        outcome = self._outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


def make_transcriber_deps(conn: Any, backend: Any) -> transcriber.Deps:
    return transcriber.Deps(
        settings=Settings(),
        conn=conn,
        backend=backend,
        r2_client=object(),
        rate_limited=False,
    )


def make_diarizer_deps(conn: Any, backend: Any) -> diarizer.Deps:
    return diarizer.Deps(
        settings=Settings(), conn=conn, backend=backend, r2_client=object()
    )


def make_stitcher_deps(conn: Any) -> stitcher.Deps:
    return stitcher.Deps(settings=Settings(), conn=conn)


def one_segment(start_s: float, end_s: float, text: str = "hi") -> Segment:
    return Segment(start_s=start_s, end_s=end_s, text=text)


# -- 1. kill a worker mid-chunk (crash before any write, then a clean retry) --


def test_worker_killed_mid_chunk_leaves_no_partial_state_and_retry_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeDb(total_chunks=1, duration_s=200.0)
    wire_fake_db(monkeypatch, fake)
    conn = FakeConn()

    backend = ScriptedBackend(
        [RuntimeError("worker killed mid-transcribe"), [one_segment(0.0, 5.0)]]
    )
    deps = make_transcriber_deps(conn, backend)
    payload = transcribe_payload(chunk_idx=0, total_chunks=1, offset_s=0.0)

    # First delivery: the worker process dies before it ever reaches
    # complete_chunk_job. No partial write, no counter movement -- only the
    # job ledger records the failed attempt (what the D43 retry ladder acts
    # on in production).
    with pytest.raises(RuntimeError):
        transcriber.handle_chunk_transcribe(payload, RecordingCtx(), deps)
    assert fake.meeting.chunks_done == 0
    assert fake.segments == {}
    assert fake.jobs[f"{MEETING}:transcribe:0"] == "failed"

    # Redelivery (the retry ladder's job): succeeds cleanly, exactly once.
    ctx = RecordingCtx()
    transcriber.handle_chunk_transcribe(payload, ctx, deps)
    assert fake.meeting.chunks_done == 1
    assert [s.text for s in fake.segments[0]] == ["hi"]
    assert fake.jobs[f"{MEETING}:transcribe:0"] == "done"
    assert backend.calls == 2

    # Diarization (empty turns -- doesn't matter for this scenario) closes
    # fan-in and the last-to-finish branch (diarization here) triggers stitch.
    diarize_deps = make_diarizer_deps(conn, backend=_EmptyDiarizeBackend())
    diarize_ctx = RecordingCtx()
    diarizer.handle_meeting_diarize(diarize_payload(), diarize_ctx, diarize_deps)
    assert len(diarize_ctx.published) == 1
    assert diarize_ctx.published[0][0] == MEETING_STITCH

    stitcher.handle_meeting_stitch(
        stitch_payload(), RecordingCtx(), make_stitcher_deps(conn)
    )
    assert fake.meeting.status == "done"
    assert fake.finalizations[-1].drop_segment_ids == []


class _EmptyDiarizeBackend:
    def diarize(self, audio_path: Path) -> list[BackendSpeakerTurn]:
        return []


# -- 2. duplicate delivery of an already-committed chunk -----------------------


def test_duplicate_delivery_after_commit_does_not_double_count(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakeDb(total_chunks=2, duration_s=400.0)
    wire_fake_db(monkeypatch, fake)
    conn = FakeConn()
    backend = ScriptedBackend([[one_segment(10.0, 15.0)]])
    deps = make_transcriber_deps(conn, backend)
    payload0 = transcribe_payload(chunk_idx=0, total_chunks=2, offset_s=0.0)

    # Original delivery commits (segments + counter) but the ack to
    # RabbitMQ is lost -- the D50 crash window this scenario targets.
    transcriber.handle_chunk_transcribe(payload0, RecordingCtx(), deps)
    assert fake.meeting.chunks_done == 1
    assert backend.calls == 1

    # The broker, having never seen the ack, redelivers the identical
    # message. claim_job's "already done" branch must short-circuit before
    # any backend call or counter movement.
    dup_ctx = RecordingCtx()
    transcriber.handle_chunk_transcribe(payload0, dup_ctx, deps)
    assert fake.meeting.chunks_done == 1  # unchanged
    assert backend.calls == 1  # backend never invoked again
    assert len(fake.segments[0]) == 1  # no duplicate rows
    # fan-in still open (chunk 1 missing) -- the redelivery-recheck path
    # correctly finds nothing to republish.
    assert dup_ctx.published == []

    # Chunk 1 lands, closing fan-in; diarization already done from a
    # (hypothetical) earlier finish.
    fake.meeting.diarization_done = True
    payload1 = transcribe_payload(chunk_idx=1, total_chunks=2, offset_s=290.0)
    backend2 = ScriptedBackend([[one_segment(300.0, 305.0)]])
    deps.backend = backend2
    close_ctx = RecordingCtx()
    transcriber.handle_chunk_transcribe(payload1, close_ctx, deps)
    assert fake.meeting.chunks_done == 2
    assert len(close_ctx.published) == 1  # this delivery closes fan-in

    # A duplicate of chunk 1 arriving *after* fan-in already closed:
    # per D50 this is expected to republish meeting.stitch again (harmless,
    # the stitcher's own claim_job dedups) -- but must still not touch the
    # counter or segments a second time.
    redelivered_ctx = RecordingCtx()
    transcriber.handle_chunk_transcribe(payload1, redelivered_ctx, deps)
    assert fake.meeting.chunks_done == 2
    assert len(fake.segments[1]) == 1
    assert len(redelivered_ctx.published) == 1  # republished, not double-applied

    # And the stitcher itself is redelivery-safe: running it twice produces
    # one finalization each time but no duplicate segment drops/gaps.
    stitcher.handle_meeting_stitch(
        stitch_payload(), RecordingCtx(), make_stitcher_deps(conn)
    )
    stitcher.handle_meeting_stitch(
        stitch_payload(), RecordingCtx(), make_stitcher_deps(conn)
    )
    assert fake.meeting.status == "done"


# -- 3. out-of-order completion across the racing + diarization branches -----


def test_out_of_order_chunk_and_diarization_completion_still_stitches_once(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 850s -> 3 chunks: [0,300), [290,580), [580,850) (open-ended), matching
    # the fixture already used in test_stitcher.py.
    duration = 850.0
    plan = compute_chunk_plan(duration)
    assert [c.chunk_idx for c in plan] == [0, 1, 2]

    fake = FakeDb(total_chunks=3, duration_s=duration)
    wire_fake_db(monkeypatch, fake)
    conn = FakeConn()

    def run_chunk(chunk_idx: int, offset_s: float, seg: Segment) -> RecordingCtx:
        deps = make_transcriber_deps(conn, ScriptedBackend([[seg]]))
        ctx = RecordingCtx()
        transcriber.handle_chunk_transcribe(
            transcribe_payload(chunk_idx, 3, offset_s), ctx, deps
        )
        return ctx

    # Deliberately scrambled arrival: the physically-last chunk (idx 2)
    # finishes first; diarization finishes in the middle, before the racing
    # branch closes; the chunk that actually closes fan-in (idx 1) is
    # neither the first nor the last to be *sliced*. Segment times are
    # chunk-relative (the worker shifts by offset_s, D16); absolute:
    # chunk0 -> [50,60), chunk1 -> [400,410), chunk2 -> [650,660).
    ctx2 = run_chunk(2, 580.0, one_segment(70.0, 80.0, "third"))
    assert ctx2.published == []  # 1/3 done, not closed

    ctx0 = run_chunk(0, 0.0, one_segment(50.0, 60.0, "first"))
    assert ctx0.published == []  # 2/3 done, not closed

    diar_ctx = RecordingCtx()
    turns = [
        BackendSpeakerTurn(speaker="SPEAKER_00", start_s=0.0, end_s=300.0),
        BackendSpeakerTurn(speaker="SPEAKER_01", start_s=300.0, end_s=850.0),
    ]
    diarizer.handle_meeting_diarize(
        diarize_payload(),
        diar_ctx,
        make_diarizer_deps(conn, backend=_ScriptedDiarizeBackend(turns)),
    )
    # Diarization finishes before the racing branch closes -- must not
    # trigger a premature stitch.
    assert diar_ctx.published == []
    assert fake.meeting.diarization_done is True

    ctx1 = run_chunk(1, 290.0, one_segment(110.0, 120.0, "second"))
    # The final chunk to arrive (idx 1, not idx 2) is the one that observes
    # both branches closed and triggers exactly one stitch.
    assert len(ctx1.published) == 1
    assert ctx1.published[0][0] == MEETING_STITCH

    stitch_ctx = RecordingCtx()
    stitcher.handle_meeting_stitch(stitch_payload(), stitch_ctx, make_stitcher_deps(conn))

    (finalization,) = fake.finalizations
    assert finalization.status == "done"
    assert finalization.gaps == []
    assert finalization.drop_segment_ids == []  # segments sit well clear of cut points
    # Speaker assignment and default naming survived the scrambled arrival
    # order unchanged from what a well-ordered delivery would produce
    # (determinism, D11/D55): SPEAKER_00 covers "first", SPEAKER_01 covers
    # "second" and "third".
    assert set(finalization.speaker_assignments.values()) == {"SPEAKER_00", "SPEAKER_01"}
    assert fake.meeting_speakers == {"SPEAKER_00": "Speaker 1", "SPEAKER_01": "Speaker 2"}
    assert stitch_ctx.events[0].status == "done"


class _ScriptedDiarizeBackend:
    def __init__(self, turns: list[BackendSpeakerTurn]) -> None:
        self._turns = turns

    def diarize(self, audio_path: Path) -> list[BackendSpeakerTurn]:
        return self._turns
