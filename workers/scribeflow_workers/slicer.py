"""Slicer worker (ticket 2.2): meeting.uploaded -> ffprobe duration ->
compute the chunk plan (D46) -> ffmpeg-slice to 16 kHz mono FLAC (D47),
upload each chunk to R2 -> publish one chunk.transcribe job per chunk plus
one meeting.diarize job for the full file.

Also handles meeting.finalize (ticket 5.3, D69): concatenates a bot
session's rolling segments into the meeting's canonical recording and
republishes as a plain meeting.uploaded, off the same q.slicer queue — it
already owns ffmpeg/R2/the publish primitive (D51).

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
from .messages import (
    ChunkTranscribeV1,
    MeetingDiarizeV1,
    MeetingFinalizeV1,
    MeetingUploadedV1,
    StatusEventV1,
)
from .topology import CHUNK_TRANSCRIBE, MEETING_DIARIZE, MEETING_UPLOADED, SLICER_QUEUE

log = get_logger("slicer")

STAGE = "slice"
FINALIZE_STAGE = "finalize"
# A back-to-back segment boundary has a few ms of scheduling jitter even
# with no real gap; only pad wall-clock gaps bigger than this (docs/
# meet-bot.md doesn't pin an exact value — this is the implementation's
# call on "a crash + rejoin leaves a hole" vs. normal jitter).
GAP_EPSILON_MS = 500


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


def finalize_job_key(meeting_id: str) -> str:
    return f"{meeting_id}:{FINALIZE_STAGE}:0"


def handle_meeting_finalize(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = MeetingFinalizeV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.finalize message: {err}") from err

    key = finalize_job_key(msg.meeting_id)
    try:
        _run_finalize(msg, ctx, deps, key)
    except Exception:
        deps.conn.rollback()
        raise


def _run_finalize(msg: MeetingFinalizeV1, ctx: JobContext, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, FINALIZE_STAGE):
        log.info("job.skipped_already_done", job_key=key)
        return

    segments = r2.list_bot_segments(
        deps.r2_client, deps.settings.r2_bucket, msg.tenant_id, msg.meeting_id
    )
    if not segments:
        # A finalize job is only ever published once >=1 segment was
        # uploaded (docs/meet-bot.md) — an empty listing means the message
        # is malformed or arrived before R2 read-after-write consistency
        # caught up; retrying won't invent segments that were never
        # produced, so this is permanent, not the retry ladder.
        raise PermanentError(f"no bot segments found for meeting {msg.meeting_id}")

    try:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            local_paths = [
                r2.download(deps.r2_client, deps.settings.r2_bucket, seg.key, tmp_dir)
                for seg in segments
            ]
            durations_s = [media.probe_duration_s(p) for p in local_paths]

            concat_inputs: list[Path] = []
            cursor_ms: float = segments[0].started_at_ms
            for idx, (seg, local_path, duration_s) in enumerate(
                zip(segments, local_paths, durations_s)
            ):
                gap_ms = seg.started_at_ms - cursor_ms
                if gap_ms > GAP_EPSILON_MS:
                    silence_path = tmp_dir / f"silence-{idx}.ogg"
                    media.generate_silence(silence_path, gap_ms / 1000)
                    concat_inputs.append(silence_path)
                concat_inputs.append(local_path)
                cursor_ms = seg.started_at_ms + duration_s * 1000

            final_path = tmp_dir / "recording.ogg"
            media.concat_audio(concat_inputs, final_path)

            r2_key = r2.canonical_recording_key(msg.tenant_id, msg.meeting_id)
            r2.upload(deps.r2_client, deps.settings.r2_bucket, r2_key, final_path)

        db.set_meeting_r2_key(deps.conn, msg.tenant_id, msg.meeting_id, r2_key)
        total_duration_s = (cursor_ms - segments[0].started_at_ms) / 1000
        ctx.publish(
            MEETING_UPLOADED,
            MeetingUploadedV1(
                tenant_id=msg.tenant_id,
                meeting_id=msg.meeting_id,
                r2_key=r2_key,
                duration_hint_s=total_duration_s,
            ),
        )
        db.complete_job(deps.conn, key)
        log.info(
            "meeting.finalized",
            meeting_id=msg.meeting_id,
            segments=len(segments),
            r2_key=r2_key,
            duration_s=total_duration_s,
        )
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """A slicer failure normally fails the whole meeting outright — unlike a
    chunk-transcribe exhaustion (D49), there's usually no fan-in yet to keep
    alive. But "usually" isn't "always": every retry of this job re-runs the
    per-chunk loop from scratch, and each attempt's successfully-sliced
    chunks publish real, idempotent chunk.transcribe jobs (D15) before that
    attempt itself fails partway through. Under a flaky-but-not-fully-broken
    failure (a transient R2/ffmpeg error that doesn't hit the same chunk on
    every attempt), those chunks can independently complete the pipeline —
    and the stitcher can reach a real 'done'/'partial' — before this job's
    own retries exhaust. Unconditionally overwriting that with 'failed' here
    would be the exact two-writers-of-a-terminal-state hazard D49 named for
    the chunk exhausted-hook; `fail_meeting_if_not_terminal` is the same
    guard applied to this hook."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        tenant_id = payload.get("tenant_id")
        meeting_id = payload.get("meeting_id")
        if not isinstance(tenant_id, str) or not isinstance(meeting_id, str):
            return
        stage_label = "finalizing" if payload.get("type") == "meeting.finalize" else "slicing"
        transitioned = db.fail_meeting_if_not_terminal(
            deps.conn, tenant_id, meeting_id, f"{stage_label} failed: {error}"
        )
        if not transitioned:
            log.info(
                "slicer.exhausted_after_meeting_already_terminal", meeting_id=meeting_id
            )
            return
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
        # q.slicer carries two message shapes (D69); the worker framework's
        # Handler signature has no routing key, so dispatch on the payload's
        # own `type` discriminator instead (messages.py).
        if payload.get("type") == "meeting.finalize":
            handle_meeting_finalize(payload, ctx, deps)
        else:
            handle_meeting_uploaded(payload, ctx, deps)

    worker = Worker(settings, SLICER_QUEUE, handler, on_exhausted=make_on_exhausted(deps))
    worker.run()


if __name__ == "__main__":
    main()
