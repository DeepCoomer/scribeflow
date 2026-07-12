"""Single-shot transcription worker (ticket 1.4): meeting.uploaded → download
from R2 → Whisper backend → transcript_segments, publishing status events at
each transition. Phase 2 repurposes this worker for chunk jobs; the offset
shift is already in place (0 for a whole file) so timestamps are absolute
meeting time from day one (invariant 4).

Run: python -m scribeflow_workers.transcriber
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import db, r2, rate_limiter
from .config import Settings, get_settings
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .messages import MeetingUploadedV1, StatusEventV1
from .topology import TRANSCRIBER_QUEUE
from .transcribe_backends import TranscribeBackend, create_backend

log = get_logger("transcriber")

STAGE = "transcribe"


@dataclass
class Deps:
    """Injected so tests run the full handler with fakes — no live Groq, R2,
    or broker (CLAUDE.md test conventions)."""

    settings: Settings
    conn: Any  # psycopg.Connection
    backend: TranscribeBackend
    r2_client: Any
    # Groq quota applies only to the groq backend; local skips the limiter.
    rate_limited: bool


def job_key(meeting_id: str, chunk_idx: int = 0) -> str:
    return f"{meeting_id}:{STAGE}:{chunk_idx}"


def handle_meeting_uploaded(
    payload: dict[str, Any], ctx: JobContext, deps: Deps
) -> None:
    try:
        msg = MeetingUploadedV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.uploaded message: {err}") from err

    key = job_key(msg.meeting_id)
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        return

    r2.assert_tenant_key(msg.r2_key, msg.tenant_id)

    def transition(status: Any, error: str | None = None, duration_s: int | None = None) -> None:
        db.set_meeting_status(
            deps.conn, msg.tenant_id, msg.meeting_id, status, error, duration_s
        )
        ctx.publish_event(
            StatusEventV1(
                tenant_id=msg.tenant_id,
                meeting_id=msg.meeting_id,
                status=status,
                error=error,
            )
        )

    transition("transcribing")
    try:
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = r2.download(
                deps.r2_client, deps.settings.r2_bucket, msg.r2_key, Path(tmp)
            )
            if deps.rate_limited:
                rate_limiter.wait_for_token(deps.conn)
            segments = deps.backend.transcribe(audio_path)

        # Single-shot: the whole file is chunk 0 with offset 0 — the shift is
        # a no-op here but keeps the "absolute time at the worker boundary"
        # rule (D16) uniform with Phase 2 chunk jobs.
        offset_s = 0.0
        rows = [
            db.SegmentRow(
                start_s=seg.start_s + offset_s,
                end_s=seg.end_s + offset_s,
                text=seg.text,
                words=seg.words,
            )
            for seg in segments
        ]
        db.replace_segments(deps.conn, msg.tenant_id, msg.meeting_id, 0, rows)

        duration_s = int(max((row.end_s for row in rows), default=0))
        transition("done", duration_s=duration_s or None)
        db.complete_job(deps.conn, key)
        log.info(
            "meeting.transcribed",
            meeting_id=msg.meeting_id,
            segments=len(rows),
            duration_s=duration_s,
        )
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """After the last retry, the meeting itself is marked failed so the
    dashboard shows a terminal state instead of an eternal spinner."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        tenant_id = payload.get("tenant_id")
        meeting_id = payload.get("meeting_id")
        if not isinstance(tenant_id, str) or not isinstance(meeting_id, str):
            return
        db.set_meeting_status(
            deps.conn, tenant_id, meeting_id, "failed", f"transcription failed: {error}"
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
    deps = Deps(
        settings=settings,
        conn=db.connect(settings.database_url),
        backend=create_backend(settings),
        r2_client=r2.create_client(settings),
        rate_limited=settings.transcribe_backend == "groq",
    )

    def handler(payload: dict[str, Any], ctx: JobContext) -> None:
        handle_meeting_uploaded(payload, ctx, deps)

    worker = Worker(
        settings, TRANSCRIBER_QUEUE, handler, on_exhausted=make_on_exhausted(deps)
    )
    worker.run()


if __name__ == "__main__":
    main()
