"""Stitcher (tickets 2.4 + 2.6): meeting.stitch -> dedupe chunk overlaps ->
assign speakers to the surviving segments (D55) -> mark gaps for any chunk
that exhausted retries -> finalize the meeting's terminal status. Fan-in
(D50) guarantees every chunk_idx has reached a terminal job state ('done' or
'exhausted') by the time this runs, and both fan-in branches (chunks +
diarization) are done, so speaker_turns is fully populated (or empty, if
diarization itself exhausted).

Run: python -m scribeflow_workers.stitcher
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import db
from .chunking import CHUNK_S, ChunkSpec, chunk_end_s, compute_chunk_plan, cut_point
from .config import Settings, get_settings
from .db import StitchSegmentRow
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .merge import SpeakerTurn, merge_speakers
from .messages import MeetingStatus, MeetingStitchV1, StatusEventV1
from .topology import STITCHER_QUEUE

log = get_logger("stitcher")

STAGE = "stitch"

# A pair of kept segments straddling a cut point are the same utterance when
# their overlap exceeds this fraction of the shorter one's duration (D11).
DUPLICATE_OVERLAP_FRACTION = 0.5


@dataclass
class Deps:
    settings: Settings
    conn: Any  # psycopg.Connection


def job_key(meeting_id: str) -> str:
    return f"{meeting_id}:{STAGE}:0"


def _side_assignment_keep(
    segments: list[StitchSegmentRow], present: set[int]
) -> set[str]:
    keep: set[str] = set()
    for seg in segments:
        idx = seg.chunk_idx
        lower = cut_point(idx - 1) if (idx - 1) in present else float("-inf")
        upper = cut_point(idx) if (idx + 1) in present else float("inf")
        midpoint = (seg.start_s + seg.end_s) / 2
        if lower <= midpoint < upper:
            keep.add(seg.id)
    return keep


def _edge_distance(seg: StitchSegmentRow, offset_s: float, *, is_earlier_side: bool) -> float:
    if is_earlier_side:
        return (offset_s + CHUNK_S) - seg.end_s
    return seg.start_s - offset_s


def _dedupe_cross_cut(
    segments: list[StitchSegmentRow],
    kept: set[str],
    present: set[int],
    offset_by_idx: dict[int, float],
) -> set[str]:
    by_chunk: dict[int, list[StitchSegmentRow]] = {}
    for seg in segments:
        by_chunk.setdefault(seg.chunk_idx, []).append(seg)

    for idx in sorted(present):
        if idx + 1 not in present:
            continue
        left = [s for s in by_chunk.get(idx, []) if s.id in kept]
        right = [s for s in by_chunk.get(idx + 1, []) if s.id in kept]
        for lseg in left:
            for rseg in right:
                overlap = min(lseg.end_s, rseg.end_s) - max(lseg.start_s, rseg.start_s)
                if overlap <= 0:
                    continue
                shorter = min(lseg.end_s - lseg.start_s, rseg.end_s - rseg.start_s)
                if shorter <= 0 or overlap <= DUPLICATE_OVERLAP_FRACTION * shorter:
                    continue
                l_dist = _edge_distance(lseg, offset_by_idx[idx], is_earlier_side=True)
                r_dist = _edge_distance(rseg, offset_by_idx[idx + 1], is_earlier_side=False)
                # Ties go to the lower chunk index (D11): drop the right
                # (later) segment unless it's strictly further from its edge.
                loser = rseg if l_dist >= r_dist else lseg
                kept.discard(loser.id)
    return kept


def _compute_gaps(
    duration_s: float, plan: list[ChunkSpec], present: set[int]
) -> list[tuple[float, float]]:
    covered = sorted(
        (spec.offset_s, chunk_end_s(spec, duration_s))
        for spec in plan
        if spec.chunk_idx in present
    )
    merged: list[list[float]] = []
    for start, end in covered:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])

    gaps: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in merged:
        if start > cursor:
            gaps.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < duration_s:
        gaps.append((cursor, duration_s))
    return gaps


def handle_meeting_stitch(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = MeetingStitchV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.stitch message: {err}") from err

    key = job_key(msg.meeting_id)
    try:
        _run(msg, ctx, deps, key)
    except Exception:
        deps.conn.rollback()
        raise


def _run(msg: MeetingStitchV1, ctx: JobContext, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        return

    try:
        info = db.get_stitch_info(deps.conn, msg.meeting_id)
        plan = compute_chunk_plan(info.duration_s)
        offset_by_idx = {spec.chunk_idx: spec.offset_s for spec in plan}

        chunk_statuses = db.get_chunk_statuses(deps.conn, msg.meeting_id)
        present = {idx for idx, job_status in chunk_statuses.items() if job_status == "done"}

        segments = db.get_segments_for_stitch(deps.conn, msg.meeting_id)
        kept = _side_assignment_keep(segments, present)
        kept = _dedupe_cross_cut(segments, kept, present, offset_by_idx)
        drop_ids = [seg.id for seg in segments if seg.id not in kept]

        # 2.6 (D55): assign speakers only to the segments that survive
        # dedup — a dropped segment's speaker is moot, and the merge must
        # run after side assignment/dedup decide the final segment set.
        kept_segments = [seg for seg in segments if seg.id in kept]
        turns = [
            SpeakerTurn(speaker_label=label, start_s=start_s, end_s=end_s)
            for label, start_s, end_s in db.get_speaker_turns_for_stitch(
                deps.conn, msg.meeting_id
            )
        ]
        merge_result = merge_speakers(kept_segments, turns)

        gaps = _compute_gaps(info.duration_s, plan, present)

        status: MeetingStatus
        error: str | None
        if not present:
            status = "failed"
            error = "every chunk exhausted its retries"
        elif gaps or info.diarization_error is not None:
            status = "partial"
            error = info.diarization_error
        else:
            status = "done"
            error = None

        db.finalize_stitch(
            deps.conn,
            db.StitchFinalization(
                tenant_id=msg.tenant_id,
                meeting_id=msg.meeting_id,
                drop_segment_ids=drop_ids,
                speaker_assignments=merge_result.assignments,
                speaker_defaults=merge_result.default_names,
                gaps=gaps,
                status=status,
                error=error,
            ),
        )
        ctx.publish_event(
            StatusEventV1(
                tenant_id=msg.tenant_id, meeting_id=msg.meeting_id, status=status, error=error
            )
        )
        db.complete_job(deps.conn, key)
        log.info(
            "meeting.stitched",
            meeting_id=msg.meeting_id,
            status=status,
            dropped=len(drop_ids),
            gaps=len(gaps),
        )
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """A stitch that can't complete after retries (a bug, not a data
    problem — the chunk-level failure path already goes through D49) must
    still leave the meeting in a terminal state instead of stuck in
    `transcribing` forever."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        tenant_id = payload.get("tenant_id")
        meeting_id = payload.get("meeting_id")
        if not isinstance(tenant_id, str) or not isinstance(meeting_id, str):
            return
        db.set_meeting_status(
            deps.conn, tenant_id, meeting_id, "failed", f"stitching failed: {error}"
        )
        ctx.publish_event(
            StatusEventV1(
                tenant_id=tenant_id,
                meeting_id=meeting_id,
                status="failed",
                error=error[:500],
            )
        )

    return on_exhausted


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    deps = Deps(settings=settings, conn=db.connect(settings.database_url))

    def handler(payload: dict[str, Any], ctx: JobContext) -> None:
        handle_meeting_stitch(payload, ctx, deps)

    worker = Worker(settings, STITCHER_QUEUE, handler, on_exhausted=make_on_exhausted(deps))
    worker.run()


if __name__ == "__main__":
    main()
