"""Chunk transcriber (ticket 2.3): chunk.transcribe -> download the chunk
from R2 -> Whisper backend -> hallucination filter (D48) -> timestamp shift
-> transcript_segments, with the fan-in counter and stitch trigger (D50)
folded into the same transaction as the segment write.

Phase 1's single-shot worker used to live here (whole meeting = chunk 0,
offset 0); the slicer (ticket 2.2) now owns that shape, so this module is
chunk-only. Run: python -m scribeflow_workers.transcriber
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import db, r2, rate_limiter
from .config import Settings, get_settings
from .db import ChunkCompletion, SegmentRow
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .messages import ChunkTranscribeV1, MeetingStitchV1
from .topology import MEETING_STITCH, TRANSCRIBER_QUEUE
from .transcribe_backends import Segment, TranscribeBackend, create_backend

log = get_logger("transcriber")

STAGE = "transcribe"

# Whisper's own non-speech/repetition heuristics (D48).
NO_SPEECH_PROB_THRESHOLD = 0.6
AVG_LOGPROB_THRESHOLD = -1.0
COMPRESSION_RATIO_THRESHOLD = 2.4


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


def job_key(meeting_id: str, chunk_idx: int) -> str:
    return f"{meeting_id}:{STAGE}:{chunk_idx}"


def is_hallucinated(seg: Segment) -> bool:
    if (
        seg.no_speech_prob is not None
        and seg.avg_logprob is not None
        and seg.no_speech_prob > NO_SPEECH_PROB_THRESHOLD
        and seg.avg_logprob < AVG_LOGPROB_THRESHOLD
    ):
        return True
    return (
        seg.compression_ratio is not None
        and seg.compression_ratio > COMPRESSION_RATIO_THRESHOLD
    )


def _maybe_trigger_stitch(
    conn: Any, tenant_id: str, meeting_id: str, completion: ChunkCompletion, ctx: JobContext
) -> None:
    if completion.chunks_done < completion.total_chunks:
        return
    if not db.get_fan_in(conn, meeting_id).diarization_done:
        return
    ctx.publish(
        MEETING_STITCH, MeetingStitchV1(tenant_id=tenant_id, meeting_id=meeting_id)
    )


def handle_chunk_transcribe(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = ChunkTranscribeV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid chunk.transcribe message: {err}") from err

    key = job_key(msg.meeting_id, msg.chunk_idx)
    try:
        _run(msg, ctx, deps, key)
    except Exception:
        # deps.conn is one connection reused for this worker process's whole
        # lifetime — without this, a failed statement leaves the transaction
        # aborted and every later job on this process fails at its first
        # query forever (the bug the Phase 1 postmortem found).
        deps.conn.rollback()
        raise


def _run(msg: ChunkTranscribeV1, ctx: JobContext, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        # A crash between the fan-in commit and publishing meeting.stitch
        # (D50) resurfaces here: the redelivered message finds its job
        # already done, so re-check whether fan-in is closed and, if the
        # meeting hasn't been stitched yet, republish — harmless if the
        # stitcher already ran, since its own claim_job dedups.
        fan_in = db.get_fan_in(deps.conn, msg.meeting_id)
        if (
            fan_in.chunks_done >= fan_in.total_chunks
            and fan_in.diarization_done
            and fan_in.status == "transcribing"
        ):
            ctx.publish(
                MEETING_STITCH,
                MeetingStitchV1(tenant_id=msg.tenant_id, meeting_id=msg.meeting_id),
            )
        return

    r2.assert_tenant_key(msg.r2_key, msg.tenant_id)

    try:
        with tempfile.TemporaryDirectory() as tmp:
            audio_path = r2.download(
                deps.r2_client, deps.settings.r2_bucket, msg.r2_key, Path(tmp)
            )
            if deps.rate_limited:
                rate_limiter.wait_for_token(deps.conn)
            raw_segments = deps.backend.transcribe(audio_path)

        rows = [
            SegmentRow(
                start_s=seg.start_s + msg.offset_s,
                end_s=seg.end_s + msg.offset_s,
                text=seg.text,
                words=seg.words,
            )
            for seg in raw_segments
            if not is_hallucinated(seg)
        ]
        completion = db.complete_chunk_job(
            deps.conn, msg.tenant_id, msg.meeting_id, msg.chunk_idx, key, rows
        )
        log.info(
            "chunk.transcribed",
            meeting_id=msg.meeting_id,
            chunk_idx=msg.chunk_idx,
            segments=len(rows),
            chunks_done=completion.chunks_done,
            total_chunks=completion.total_chunks,
        )
        _maybe_trigger_stitch(deps.conn, msg.tenant_id, msg.meeting_id, completion, ctx)
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """After the last retry, the chunk is marked exhausted (D49): fan-in
    still needs the increment (a dead chunk can't wedge the meeting), and the
    stitcher — not this hook — decides the terminal status from the gap it
    computes."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        try:
            msg = ChunkTranscribeV1.model_validate(payload)
        except ValueError:
            return
        key = job_key(msg.meeting_id, msg.chunk_idx)
        completion = db.exhaust_chunk_job(deps.conn, msg.meeting_id, key)
        log.error(
            "chunk.exhausted",
            meeting_id=msg.meeting_id,
            chunk_idx=msg.chunk_idx,
            error=error,
        )
        _maybe_trigger_stitch(deps.conn, msg.tenant_id, msg.meeting_id, completion, ctx)

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
        handle_chunk_transcribe(payload, ctx, deps)

    worker = Worker(
        settings, TRANSCRIBER_QUEUE, handler, on_exhausted=make_on_exhausted(deps)
    )
    worker.run()


if __name__ == "__main__":
    main()
