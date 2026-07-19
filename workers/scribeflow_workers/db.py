"""Postgres access for workers (psycopg3, plain SQL). Every function takes
tenant_id and scopes its WHERE clause with it (D20) — same rule as the API's
repositories, no worker-side bypass. Writes are upsert/replace shaped so
RabbitMQ redelivery is harmless (D15).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import psycopg


def connect(database_url: str) -> psycopg.Connection[Any]:
    # postgres:// is valid for psycopg but normalize for safety.
    url = database_url.replace("postgres://", "postgresql://", 1)
    return psycopg.connect(url, autocommit=False)


# -- job ledger (D15) ---------------------------------------------------------


def claim_job(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    job_key: str,
    stage: str,
) -> bool:
    """Record the attempt and return False when the job already completed —
    the idempotency check that makes redelivery a no-op."""
    with conn.cursor() as cur:
        # RETURNING sees the post-upsert row: 'done' survives the update, so
        # a redelivered job that already finished returns False here.
        cur.execute(
            """
            INSERT INTO jobs (tenant_id, meeting_id, job_key, stage, status, attempts)
            VALUES (%s, %s, %s, %s, 'running', 1)
            ON CONFLICT (job_key) DO UPDATE
              SET attempts = jobs.attempts + 1,
                  -- INSERT's 'running' above is cast implicitly (Postgres
                  -- infers the target column type for a plain VALUES
                  -- literal); a CASE expression's branches don't get that
                  -- inference — both sides resolve to text, so assigning
                  -- the result to the job_status enum needs an explicit
                  -- cast or it's a DatatypeMismatch at execute time.
                  status = (CASE WHEN jobs.status = 'done' THEN 'done' ELSE 'running' END)::job_status,
                  updated_at = now()
            RETURNING status
            """,
            (tenant_id, meeting_id, job_key, stage),
        )
        row = cur.fetchone()
    conn.commit()
    return row is not None and row[0] != "done"


def complete_job(conn: psycopg.Connection[Any], job_key: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "UPDATE jobs SET status = 'done', updated_at = now() WHERE job_key = %s",
            (job_key,),
        )
    conn.commit()


def fail_job(conn: psycopg.Connection[Any], job_key: str, error: str) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE jobs SET status = 'failed', last_error = %s, updated_at = now()
            WHERE job_key = %s
            """,
            (error[:2000], job_key),
        )
    conn.commit()


# -- meetings -----------------------------------------------------------------


def init_chunk_plan(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    total_chunks: int,
    duration_s: int,
) -> None:
    """Guarded by `total_chunks = 0` so a redelivered slicer job (same
    deterministic plan, since it recomputes from the same ffprobe duration)
    never resets counters mid-flight (D46)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE meetings
            SET total_chunks = %s, duration_s = %s
            WHERE id = %s AND tenant_id = %s AND total_chunks = 0
            """,
            (total_chunks, duration_s, meeting_id, tenant_id),
        )
    conn.commit()


@dataclass(frozen=True)
class FanIn:
    chunks_done: int
    total_chunks: int
    diarization_done: bool
    status: str


def get_fan_in(conn: psycopg.Connection[Any], meeting_id: str) -> FanIn:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT chunks_done, total_chunks, diarization_done, status "
            "FROM meetings WHERE id = %s",
            (meeting_id,),
        )
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    return FanIn(
        chunks_done=row[0], total_chunks=row[1], diarization_done=row[2], status=row[3]
    )


def set_diarization_done(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    error: str | None = None,
) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE meetings SET diarization_done = true, diarization_error = %s
            WHERE id = %s AND tenant_id = %s
            """,
            (error, meeting_id, tenant_id),
        )
    conn.commit()


@dataclass(frozen=True)
class ChunkCompletion:
    # False when this call observed an already-terminal job (redelivery) —
    # the exactly-once guard for the chunks_done increment (D50).
    transitioned: bool
    chunks_done: int
    total_chunks: int


def complete_chunk_job(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    chunk_idx: int,
    job_key: str,
    segments: list[SegmentRow],
) -> ChunkCompletion:
    """Segments + job completion + fan-in counter in one transaction (D50):
    the conditional job-status transition is the exactly-once guard for the
    counter increment, so a crash-and-redeliver can't double-count."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM meetings WHERE id = %s AND tenant_id = %s",
            (meeting_id, tenant_id),
        )
        if cur.fetchone() is None:
            conn.rollback()
            raise ValueError(f"meeting {meeting_id} not found for tenant {tenant_id}")

        cur.execute(
            "DELETE FROM transcript_segments WHERE meeting_id = %s AND chunk_idx = %s",
            (meeting_id, chunk_idx),
        )
        cur.executemany(
            """
            INSERT INTO transcript_segments
              (meeting_id, chunk_idx, start_s, end_s, text, words_jsonb)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    meeting_id,
                    chunk_idx,
                    seg.start_s,
                    seg.end_s,
                    seg.text,
                    json.dumps(seg.words) if seg.words is not None else None,
                )
                for seg in segments
            ],
        )
        transitioned, chunks_done, total_chunks = _transition_and_count(
            cur, meeting_id, job_key, "done"
        )
    conn.commit()
    return ChunkCompletion(transitioned, chunks_done, total_chunks)


def exhaust_chunk_job(
    conn: psycopg.Connection[Any], meeting_id: str, job_key: str
) -> ChunkCompletion:
    """Terminal state for a chunk that exhausted its retries (D49): no
    segments are written, but fan-in still needs to close, so the counter
    increments under the same exactly-once guard as a successful chunk."""
    with conn.cursor() as cur:
        transitioned, chunks_done, total_chunks = _transition_and_count(
            cur, meeting_id, job_key, "exhausted"
        )
    conn.commit()
    return ChunkCompletion(transitioned, chunks_done, total_chunks)


def _transition_and_count(
    cur: psycopg.Cursor[Any], meeting_id: str, job_key: str, terminal_status: str
) -> tuple[bool, int, int]:
    cur.execute(
        "UPDATE jobs SET status = %s::job_status, updated_at = now() "
        "WHERE job_key = %s AND status <> %s::job_status RETURNING job_key",
        (terminal_status, job_key, terminal_status),
    )
    transitioned = cur.fetchone() is not None
    if transitioned:
        cur.execute(
            "UPDATE meetings SET chunks_done = chunks_done + 1 "
            "WHERE id = %s RETURNING chunks_done, total_chunks",
            (meeting_id,),
        )
    else:
        cur.execute(
            "SELECT chunks_done, total_chunks FROM meetings WHERE id = %s",
            (meeting_id,),
        )
    row = cur.fetchone()
    assert row is not None
    return transitioned, row[0], row[1]


def get_chunk_statuses(conn: psycopg.Connection[Any], meeting_id: str) -> dict[int, str]:
    """Per-chunk terminal state (done/exhausted) for the transcribe stage,
    keyed by chunk_idx parsed from the deterministic job key (D15)."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT job_key, status FROM jobs WHERE meeting_id = %s AND stage = %s",
            (meeting_id, "transcribe"),
        )
        rows = cur.fetchall()
    conn.commit()
    return {int(job_key.rsplit(":", 1)[-1]): status for job_key, status in rows}


@dataclass(frozen=True)
class StitchSegmentRow:
    id: str
    chunk_idx: int
    start_s: float
    end_s: float


@dataclass(frozen=True)
class StitchInfo:
    duration_s: float
    total_chunks: int
    diarization_error: str | None


def get_stitch_info(conn: psycopg.Connection[Any], meeting_id: str) -> StitchInfo:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT duration_s, total_chunks, diarization_error FROM meetings WHERE id = %s",
            (meeting_id,),
        )
        row = cur.fetchone()
    conn.commit()
    assert row is not None
    return StitchInfo(duration_s=row[0], total_chunks=row[1], diarization_error=row[2])


def get_segments_for_stitch(
    conn: psycopg.Connection[Any], meeting_id: str
) -> list[StitchSegmentRow]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, chunk_idx, start_s, end_s FROM transcript_segments "
            "WHERE meeting_id = %s",
            (meeting_id,),
        )
        rows = cur.fetchall()
    conn.commit()
    return [
        StitchSegmentRow(id=str(r[0]), chunk_idx=r[1], start_s=r[2], end_s=r[3]) for r in rows
    ]


@dataclass(frozen=True)
class StitchFinalization:
    tenant_id: str
    meeting_id: str
    drop_segment_ids: list[str]
    # Kept-segment id -> diarized label (None = no overlapping turn, D55).
    # Every kept segment gets an entry so a re-stitch overwrites a stale
    # assignment instead of leaving it stuck.
    speaker_assignments: dict[str, str | None]
    # Diarized label -> "Speaker N" default (D56); seeded via ON CONFLICT DO
    # NOTHING so it never clobbers a user's rename.
    speaker_defaults: dict[str, str]
    gaps: list[tuple[float, float]]
    status: str
    error: str | None = None


def finalize_stitch(conn: psycopg.Connection[Any], finalization: StitchFinalization) -> None:
    """Deletes losing overlap segments, assigns speakers, seeds default
    display names, replaces the gap markers, and sets the terminal status —
    one transaction, so a crash mid-stitch can't leave duplicate segments,
    duplicate gap rows, or a half-speakered meeting behind (re-running
    produces the same keep/drop/assignment decisions, D49/D11/D55)."""
    with conn.cursor() as cur:
        if finalization.drop_segment_ids:
            cur.execute(
                "DELETE FROM transcript_segments WHERE id = ANY(%s)",
                (finalization.drop_segment_ids,),
            )
        if finalization.speaker_assignments:
            cur.executemany(
                "UPDATE transcript_segments SET speaker = %s WHERE id = %s",
                [
                    (label, seg_id)
                    for seg_id, label in finalization.speaker_assignments.items()
                ],
            )
        if finalization.speaker_defaults:
            cur.executemany(
                """
                INSERT INTO meeting_speakers (meeting_id, speaker_label, display_name)
                VALUES (%s, %s, %s)
                ON CONFLICT (meeting_id, speaker_label) DO NOTHING
                """,
                [
                    (finalization.meeting_id, label, name)
                    for label, name in finalization.speaker_defaults.items()
                ],
            )
        cur.execute(
            "DELETE FROM transcript_gaps WHERE meeting_id = %s", (finalization.meeting_id,)
        )
        cur.executemany(
            """
            INSERT INTO transcript_gaps (meeting_id, start_s, end_s, reason)
            VALUES (%s, %s, %s, %s)
            """,
            [
                (finalization.meeting_id, start, end, "chunk_failed")
                for start, end in finalization.gaps
            ],
        )
        cur.execute(
            "UPDATE meetings SET status = %s, error = %s WHERE id = %s AND tenant_id = %s",
            (
                finalization.status,
                finalization.error,
                finalization.meeting_id,
                finalization.tenant_id,
            ),
        )
    conn.commit()


def insert_speaker_turns(
    conn: psycopg.Connection[Any], meeting_id: str, turns: list[tuple[str, float, float]]
) -> None:
    """Replace-by-meeting (redelivery-safe, mirrors replace_segments): raw
    pyannote turns land here for the stitcher's speaker merge (2.6) to
    consume, and stay after the merge runs (D57) for idempotent re-stitching
    and Phase 4.1's interruption metric."""
    with conn.cursor() as cur:
        cur.execute("DELETE FROM speaker_turns WHERE meeting_id = %s", (meeting_id,))
        cur.executemany(
            """
            INSERT INTO speaker_turns (meeting_id, speaker_label, start_s, end_s)
            VALUES (%s, %s, %s, %s)
            """,
            [(meeting_id, speaker, start, end) for speaker, start, end in turns],
        )
    conn.commit()


def get_speaker_turns_for_stitch(
    conn: psycopg.Connection[Any], meeting_id: str
) -> list[tuple[str, float, float]]:
    """Raw pyannote turns for the stitcher's merge step (D55). Empty when
    diarization exhausted its retries (D50) or found no speech — the merge
    module treats an empty list as a no-op, matching D48's "empty is a
    success" precedent."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT speaker_label, start_s, end_s FROM speaker_turns WHERE meeting_id = %s",
            (meeting_id,),
        )
        rows = cur.fetchall()
    conn.commit()
    return [(r[0], r[1], r[2]) for r in rows]


def set_meeting_status(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    status: str,
    error: str | None = None,
    duration_s: int | None = None,
) -> None:
    sets = ["status = %s", "error = %s"]
    params: list[Any] = [status, error]
    if duration_s is not None:
        sets.append("duration_s = %s")
        params.append(duration_s)
    params.extend([meeting_id, tenant_id])
    with conn.cursor() as cur:
        cur.execute(
            f"UPDATE meetings SET {', '.join(sets)} WHERE id = %s AND tenant_id = %s",
            params,
        )
    conn.commit()


def fail_meeting_if_not_terminal(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    error: str,
) -> bool:
    """Marks a meeting failed unless it already reached a terminal status
    (D49 owns that transition set: done/partial/failed). Exists for
    exhausted-hooks that sit outside the fan-in/stitch machinery (the
    slicer's, specifically): its own retries can publish real, idempotent
    chunk jobs before the slicer job itself gives up, and those chunks can
    independently complete the pipeline through a real stitch before the
    slicer's last retry fails — this guard is what stops that correct
    outcome from being overwritten by a stale 'failed', the same
    two-writers-of-a-terminal-state hazard D49 named for the chunk
    exhausted-hook. Returns whether it actually transitioned, so a caller
    can skip publishing a status event that would otherwise contradict the
    real (already-delivered) terminal state."""
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE meetings SET status = 'failed', error = %s
            WHERE id = %s AND tenant_id = %s
              AND status <> 'done' AND status <> 'partial' AND status <> 'failed'
            RETURNING id
            """,
            (error, meeting_id, tenant_id),
        )
        transitioned = cur.fetchone() is not None
    conn.commit()
    return transitioned


# -- transcript segments --------------------------------------------------------


@dataclass(frozen=True)
class SegmentRow:
    start_s: float
    end_s: float
    text: str
    words: list[dict[str, Any]] | None = None


def replace_segments(
    conn: psycopg.Connection[Any],
    tenant_id: str,
    meeting_id: str,
    chunk_idx: int,
    segments: list[SegmentRow],
) -> None:
    """Delete-and-insert for one (meeting, chunk) in a single transaction:
    deterministic under redelivery, and partial writes can't survive a crash.
    The meeting lookup doubles as the tenant check — a mismatched tenant_id
    writes nothing."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM meetings WHERE id = %s AND tenant_id = %s",
            (meeting_id, tenant_id),
        )
        if cur.fetchone() is None:
            conn.rollback()
            raise ValueError(f"meeting {meeting_id} not found for tenant {tenant_id}")
        cur.execute(
            "DELETE FROM transcript_segments WHERE meeting_id = %s AND chunk_idx = %s",
            (meeting_id, chunk_idx),
        )
        cur.executemany(
            """
            INSERT INTO transcript_segments
              (meeting_id, chunk_idx, start_s, end_s, text, words_jsonb)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    meeting_id,
                    chunk_idx,
                    seg.start_s,
                    seg.end_s,
                    seg.text,
                    json.dumps(seg.words) if seg.words is not None else None,
                )
                for seg in segments
            ],
        )
    conn.commit()
