"""Diarizer worker (ticket 2.5): meeting.diarize -> pyannote on the full
file (never chunked, D12) -> speaker_turns -> mark diarization_done and,
if the racing branch already closed fan-in, trigger the stitch.

Run: python -m scribeflow_workers.diarizer
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import db, r2
from .config import Settings, get_settings
from .diarize_backends import DiarizeBackend, create_backend
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .messages import MeetingDiarizeV1, MeetingStitchV1
from .topology import DIARIZER_QUEUE, MEETING_STITCH

log = get_logger("diarizer")

STAGE = "diarize"


@dataclass
class Deps:
    settings: Settings
    conn: Any  # psycopg.Connection
    backend: DiarizeBackend
    r2_client: Any


def job_key(meeting_id: str) -> str:
    return f"{meeting_id}:{STAGE}:0"


def _maybe_trigger_stitch(conn: Any, tenant_id: str, meeting_id: str, ctx: JobContext) -> None:
    fan_in = db.get_fan_in(conn, meeting_id)
    if fan_in.chunks_done >= fan_in.total_chunks and fan_in.diarization_done:
        ctx.publish(MEETING_STITCH, MeetingStitchV1(tenant_id=tenant_id, meeting_id=meeting_id))


def handle_meeting_diarize(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = MeetingDiarizeV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.diarize message: {err}") from err

    key = job_key(msg.meeting_id)
    try:
        _run(msg, ctx, deps, key)
    except Exception:
        deps.conn.rollback()
        raise


def _run(msg: MeetingDiarizeV1, ctx: JobContext, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        # Same crash-window closure as the chunk transcriber (D50): a
        # redelivery that finds this job already done still re-checks
        # whether the racing branch closed fan-in while we were down.
        _maybe_trigger_stitch(deps.conn, msg.tenant_id, msg.meeting_id, ctx)
        return

    r2.assert_tenant_key(msg.r2_key, msg.tenant_id)

    try:
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = r2.download(
                deps.r2_client, deps.settings.r2_bucket, msg.r2_key, Path(tmp)
            )
            turns = deps.backend.diarize(audio_path)

        db.insert_speaker_turns(
            deps.conn,
            msg.meeting_id,
            [(t.speaker, t.start_s, t.end_s) for t in turns],
        )
        db.set_diarization_done(deps.conn, msg.tenant_id, msg.meeting_id)
        db.complete_job(deps.conn, key)
        log.info("meeting.diarized", meeting_id=msg.meeting_id, turns=len(turns))
        _maybe_trigger_stitch(deps.conn, msg.tenant_id, msg.meeting_id, ctx)
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """Diarization giving up must not block the stitch forever (D50): mark
    it done-with-error so fan-in can still close, and the stitcher forces the
    terminal status to `partial` when it sees a diarization error recorded."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        tenant_id = payload.get("tenant_id")
        meeting_id = payload.get("meeting_id")
        if not isinstance(tenant_id, str) or not isinstance(meeting_id, str):
            return
        db.set_diarization_done(deps.conn, tenant_id, meeting_id, error=error[:2000])
        log.error("diarization.exhausted", meeting_id=meeting_id, error=error)
        _maybe_trigger_stitch(deps.conn, tenant_id, meeting_id, ctx)

    return on_exhausted


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    deps = Deps(
        settings=settings,
        conn=db.connect(settings.database_url),
        backend=create_backend(settings),
        r2_client=r2.create_client(settings),
    )

    def handler(payload: dict[str, Any], ctx: JobContext) -> None:
        handle_meeting_diarize(payload, ctx, deps)

    worker = Worker(settings, DIARIZER_QUEUE, handler, on_exhausted=make_on_exhausted(deps))
    worker.run()


if __name__ == "__main__":
    main()
