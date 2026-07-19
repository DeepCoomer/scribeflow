"""Embedder (ticket 3.5, D63): meeting.embed -> embed every transcript
segment's text with a local CPU model -> write transcript_segments.embedding.
Triggered by the stitcher alongside meeting.extract, once a meeting reaches
`done` or `partial` (same "nothing to embed from an empty/failed transcript"
reasoning as the extractor). Runs independently of extraction: a failed or
slow embed pass never blocks or retries the intelligence pass, and vice
versa (invariant 5's "parallel, merge/finalize independently" shape).

Best-effort, not part of the pipeline's terminal-status contract: the RAG
chat (3.6) simply can't retrieve segments that were never embedded, the same
way the dashboard shows a blank sentiment cue for a segment sentiment never
scored.

Run: python -m scribeflow_workers.embedder
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from . import db
from .config import Settings, get_settings
from .embed_backends import EmbeddingBackend, create_embedding_backend
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .messages import MeetingEmbedV1
from .topology import EMBEDDER_QUEUE

log = get_logger("embedder")

STAGE = "embed"


@dataclass
class Deps:
    """Injected so tests run the full handler with a fake backend — no
    model load in CI (CLAUDE.md test conventions)."""

    settings: Settings
    conn: Any  # psycopg.Connection
    backend: EmbeddingBackend


def job_key(meeting_id: str) -> str:
    return f"{meeting_id}:{STAGE}:0"


def handle_meeting_embed(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = MeetingEmbedV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.embed message: {err}") from err

    key = job_key(msg.meeting_id)
    try:
        _run(msg, deps, key)
    except Exception:
        # Same reasoning as the other workers: one connection reused for the
        # process's lifetime, so a failed statement must roll back or every
        # later job on this process fails at its first query forever.
        deps.conn.rollback()
        raise


def _run(msg: MeetingEmbedV1, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        return

    try:
        segments = db.get_segments_for_embedding(deps.conn, msg.meeting_id)
        if segments:
            vectors = deps.backend.embed([seg.text for seg in segments])
            db.write_embeddings(
                deps.conn, list(zip((s.id for s in segments), vectors, strict=True))
            )
        db.complete_job(deps.conn, key)
        log.info("meeting.embedded", meeting_id=msg.meeting_id, segments=len(segments))
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    def on_exhausted(payload: dict[str, Any], error: str, _ctx: JobContext) -> None:
        meeting_id = payload.get("meeting_id")
        log.error("meeting.embed_exhausted", meeting_id=meeting_id, error=error)

    return on_exhausted


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    deps = Deps(
        settings=settings,
        conn=db.connect(settings.database_url),
        backend=create_embedding_backend(settings),
    )

    def handler(payload: dict[str, Any], ctx: JobContext) -> None:
        handle_meeting_embed(payload, ctx, deps)

    worker = Worker(settings, EMBEDDER_QUEUE, handler, on_exhausted=make_on_exhausted(deps))
    worker.run()


if __name__ == "__main__":
    main()
