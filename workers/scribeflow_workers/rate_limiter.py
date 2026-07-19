"""Shared token-bucket rate limiter in front of Groq (D24, invariant 6).

The bucket row lives in Postgres (`rate_limiter_buckets`) and is guarded by
a transaction-scoped advisory lock, so the 20 req/min budget holds org-wide
across any number of worker processes — per-worker limiters don't compose.
"""

from __future__ import annotations

import time
from typing import Any

import psycopg

GROQ_BUCKET = "groq"
# Separate bucket for the Phase 3 LLM calls (3.1/3.2): Groq's free-tier rate
# limits are per-model, so the extraction/sentiment quota doesn't share the
# Whisper bucket's budget.
GROQ_LLM_BUCKET = "groq_llm"


def try_acquire_token(
    conn: psycopg.Connection[Any],
    bucket: str,
    rate_per_min: float,
    burst: float,
) -> bool:
    """Refill by elapsed time, then spend one token if available."""
    with conn.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (bucket,))
        cur.execute(
            """
            INSERT INTO rate_limiter_buckets (key, tokens, updated_at)
            VALUES (%s, %s, now())
            ON CONFLICT (key) DO NOTHING
            """,
            (bucket, burst),
        )
        cur.execute(
            """
            UPDATE rate_limiter_buckets
            SET tokens = LEAST(
                  %s,
                  tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * %s / 60.0
                ),
                updated_at = now()
            WHERE key = %s
            RETURNING tokens
            """,
            (burst, rate_per_min, bucket),
        )
        row = cur.fetchone()
        assert row is not None
        tokens = float(row[0])
        if tokens < 1.0:
            conn.commit()
            return False
        cur.execute(
            "UPDATE rate_limiter_buckets SET tokens = tokens - 1 WHERE key = %s",
            (bucket,),
        )
    conn.commit()
    return True


def wait_for_token(
    conn: psycopg.Connection[Any],
    bucket: str = GROQ_BUCKET,
    rate_per_min: float = 20.0,
    burst: float = 20.0,
    poll_s: float = 1.0,
    timeout_s: float = 300.0,
) -> None:
    deadline = time.monotonic() + timeout_s
    while not try_acquire_token(conn, bucket, rate_per_min, burst):
        if time.monotonic() >= deadline:
            raise TimeoutError(f"no {bucket} rate-limit token within {timeout_s}s")
        time.sleep(poll_s)
