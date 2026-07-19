"""Slicer worker (ticket 2.2): meeting.uploaded -> ffprobe duration ->
compute the chunk plan (D46) -> ffmpeg-slice to 16 kHz mono FLAC (D47),
upload each chunk to R2 -> publish one chunk.transcribe job per chunk plus
one meeting.diarize job for the full file.

Run: python -m scribeflow_workers.slicer
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import db, media, r2
from .chunking import compute_chunk_plan
from .config import Settings, get_settings
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .messages import ChunkTranscribeV1, MeetingDiarizeV1, MeetingUploadedV1, StatusEventV1
from .topology import CHUNK_TRANSCRIBE, MEETING_DIARIZE, SLICER_QUEUE

log = get_logger("slicer")

STAGE = "slice"


@dataclass
class Deps:
    settings: Settings
    conn: Any  # psycopg.Connection
    r2_client: Any


def job_key(meeting_id: str) -> str:
    return f"{meeting_id}:{STAGE}:0"


def handle_meeting_uploaded(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = MeetingUploadedV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.uploaded message: {err}") from err

    key = job_key(msg.meeting_id)
    try:
        _run(msg, ctx, deps, key)
    except Exception:
        # Same shared-connection rollback rule as the chunk transcriber
        # (workers/scribeflow_workers/transcriber.py) — an unrolled-back
        # aborted transaction would poison every later job on this process.
        deps.conn.rollback()
        raise


def _run(msg: MeetingUploadedV1, ctx: JobContext, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        return

    r2.assert_tenant_key(msg.r2_key, msg.tenant_id)

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            audio_path = r2.download(
                deps.r2_client, deps.settings.r2_bucket, msg.r2_key, tmp_dir
            )
            duration_s = media.probe_duration_s(audio_path)
            plan = compute_chunk_plan(duration_s)

            db.init_chunk_plan(
                deps.conn, msg.tenant_id, msg.meeting_id, len(plan), round(duration_s)
            )

            for spec in plan:
                chunk_path = tmp_dir / f"chunk-{spec.chunk_idx}.flac"
                media.slice_to_flac(
                    audio_path, chunk_path, spec.offset_s, spec.duration_s
                )
                key_ = r2.chunk_key(msg.tenant_id, msg.meeting_id, spec.chunk_idx)
                r2.upload(deps.r2_client, deps.settings.r2_bucket, key_, chunk_path)
                ctx.publish(
                    CHUNK_TRANSCRIBE,
                    ChunkTranscribeV1(
                        tenant_id=msg.tenant_id,
                        meeting_id=msg.meeting_id,
                        chunk_idx=spec.chunk_idx,
                        total_chunks=len(plan),
                        offset_s=spec.offset_s,
                        r2_key=key_,
                    ),
                )

        ctx.publish(
            MEETING_DIARIZE,
            MeetingDiarizeV1(
                tenant_id=msg.tenant_id, meeting_id=msg.meeting_id, r2_key=msg.r2_key
            ),
        )

        db.set_meeting_status(deps.conn, msg.tenant_id, msg.meeting_id, "transcribing")
        ctx.publish_event(
            StatusEventV1(
                tenant_id=msg.tenant_id, meeting_id=msg.meeting_id, status="transcribing"
            )
        )
        db.complete_job(deps.conn, key)
        log.info(
            "meeting.sliced",
            meeting_id=msg.meeting_id,
            total_chunks=len(plan),
            duration_s=duration_s,
        )
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """Unlike a chunk-transcribe exhaustion (D49), nothing has been sliced
    yet, so there's no fan-in to keep alive — a slicer failure just fails
    the whole meeting, same shape as Phase 1's single-shot exhausted-hook."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        tenant_id = payload.get("tenant_id")
        meeting_id = payload.get("meeting_id")
        if not isinstance(tenant_id, str) or not isinstance(meeting_id, str):
            return
        db.set_meeting_status(
            deps.conn, tenant_id, meeting_id, "failed", f"slicing failed: {error}"
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
        r2_client=r2.create_client(settings),
    )

    def handler(payload: dict[str, Any], ctx: JobContext) -> None:
        handle_meeting_uploaded(payload, ctx, deps)

    worker = Worker(settings, SLICER_QUEUE, handler, on_exhausted=make_on_exhausted(deps))
    worker.run()


if __name__ == "__main__":
    main()
