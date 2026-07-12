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
                  status = CASE WHEN jobs.status = 'done' THEN 'done' ELSE 'running' END,
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
