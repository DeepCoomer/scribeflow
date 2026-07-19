"""Extractor (tickets 3.1 + 3.2, D59): meeting.extract -> build the final
transcript -> Groq LLM pass for action items / decisions / summary (strict
JSON schema, retry-on-invalid) -> batched per-utterance sentiment scoring ->
one finalize transaction. Triggered by the stitcher once a meeting reaches
`done` or `partial` (never `failed` — nothing to extract from an empty
transcript with zero surviving chunks).

Run: python -m scribeflow_workers.extractor
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from . import db, rate_limiter
from .config import Settings, get_settings
from .db import ActionItemInput, ExtractionSegmentRow, SentimentUpdate
from .extract_backends import (
    ExtractionBackend,
    ExtractionResult,
    create_extraction_backend,
)
from .framework import JobContext, PermanentError, Worker
from .logging import configure_logging, get_logger
from .messages import ExtractionEventV1, MeetingExtractV1
from .rate_limiter import GROQ_LLM_BUCKET
from .topology import EXTRACTOR_QUEUE

log = get_logger("extractor")

STAGE = "extract"

# Keeps a portfolio-scale meeting comfortably inside the model's context
# window without building full map-reduce chunking for v1: past this many
# characters, the middle of the transcript is elided (summaries and action
# items concentrate at the start/end of a meeting far more than the middle).
TRANSCRIPT_CHAR_BUDGET = 60_000

# An extracted source_ts_s only gets attached to the nearest segment when
# it's within this many seconds — otherwise the LLM's timestamp guess is too
# loose to be a useful "jump to transcript" link.
SOURCE_TS_TOLERANCE_S = 60.0


@dataclass
class Deps:
    """Injected so tests run the full handler with fakes — no live Groq or
    broker (CLAUDE.md test conventions)."""

    settings: Settings
    conn: Any  # psycopg.Connection
    backend: ExtractionBackend
    rate_limited: bool


def job_key(meeting_id: str) -> str:
    return f"{meeting_id}:{STAGE}:0"


def _fmt_ts(seconds: float) -> str:
    total = max(0, int(seconds))
    return f"{total // 60:02d}:{total % 60:02d}"


def _build_transcript_text(
    segments: list[ExtractionSegmentRow], char_budget: int = TRANSCRIPT_CHAR_BUDGET
) -> str:
    lines = [
        f"[{_fmt_ts(seg.start_s)}] {seg.speaker_name or 'Unknown'}: {seg.text}"
        for seg in segments
    ]
    full = "\n".join(lines)
    if len(full) <= char_budget:
        return full

    half = char_budget // 2
    head: list[str] = []
    used = 0
    for line in lines:
        if used + len(line) + 1 > half:
            break
        head.append(line)
        used += len(line) + 1

    tail: list[str] = []
    used = 0
    for line in reversed(lines):
        if used + len(line) + 1 > half:
            break
        tail.append(line)
        used += len(line) + 1
    tail.reverse()

    return "\n".join(head) + "\n... [transcript truncated for length] ...\n" + "\n".join(tail)


def _nearest_segment_id(
    segments: list[ExtractionSegmentRow], ts_s: float | None
) -> str | None:
    if ts_s is None or not segments:
        return None
    best = min(segments, key=lambda seg: abs(seg.start_s - ts_s))
    if abs(best.start_s - ts_s) > SOURCE_TS_TOLERANCE_S:
        return None
    return best.id


def _parse_due_date(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)


def _build_action_items(
    result: ExtractionResult, segments: list[ExtractionSegmentRow]
) -> list[ActionItemInput]:
    return [
        ActionItemInput(
            text=item.text,
            owner_name=item.owner_name,
            due_date=_parse_due_date(item.due_date),
            confidence=item.confidence,
            source_segment_id=_nearest_segment_id(segments, item.source_ts_s),
        )
        for item in result.action_items
    ]


def _empty_result(summary: str) -> ExtractionResult:
    return ExtractionResult(summary=summary, decisions=[], action_items=[])


def handle_meeting_extract(payload: dict[str, Any], ctx: JobContext, deps: Deps) -> None:
    try:
        msg = MeetingExtractV1.model_validate(payload)
    except ValueError as err:
        raise PermanentError(f"invalid meeting.extract message: {err}") from err

    key = job_key(msg.meeting_id)
    try:
        _run(msg, ctx, deps, key)
    except Exception:
        # Same reasoning as the other workers: one connection reused for the
        # process's lifetime, so a failed statement must roll back or every
        # later job on this process fails at its first query forever.
        deps.conn.rollback()
        raise


def _run(msg: MeetingExtractV1, ctx: JobContext, deps: Deps, key: str) -> None:
    if not db.claim_job(deps.conn, msg.tenant_id, msg.meeting_id, key, STAGE):
        log.info("job.skipped_already_done", job_key=key)
        return

    try:
        segments = db.get_transcript_for_extraction(deps.conn, msg.meeting_id)

        if not segments:
            # D48's "empty is a success" precedent: a silent/empty meeting
            # gets a trivial summary and no LLM call at all.
            result = _empty_result("No speech was detected in this meeting.")
            sentiment: list[SentimentUpdate] = []
        else:
            if deps.rate_limited:
                rate_limiter.wait_for_token(
                    deps.conn,
                    bucket=GROQ_LLM_BUCKET,
                    rate_per_min=deps.settings.groq_llm_rate_per_min,
                    burst=deps.settings.groq_llm_rate_per_min,
                )
            transcript_text = _build_transcript_text(segments)
            result = deps.backend.extract(transcript_text)

            if deps.rate_limited:
                rate_limiter.wait_for_token(
                    deps.conn,
                    bucket=GROQ_LLM_BUCKET,
                    rate_per_min=deps.settings.groq_llm_rate_per_min,
                    burst=deps.settings.groq_llm_rate_per_min,
                )
            sentiment_raw = deps.backend.score_sentiment(
                [(seg.id, seg.text) for seg in segments]
            )
            sentiment = [
                SentimentUpdate(segment_id=s.segment_id, label=s.label, score=s.score)
                for s in sentiment_raw
            ]

        finalization = db.ExtractionFinalization(
            tenant_id=msg.tenant_id,
            meeting_id=msg.meeting_id,
            summary=result.summary,
            decisions=[d.model_dump() for d in result.decisions],
            model=deps.settings.groq_llm_model,
            action_items=_build_action_items(result, segments),
            sentiment=sentiment,
        )
        db.finalize_extraction(deps.conn, finalization)
        db.complete_job(deps.conn, key)
        ctx.publish_event(
            ExtractionEventV1(tenant_id=msg.tenant_id, meeting_id=msg.meeting_id, status="done")
        )
        log.info(
            "meeting.extracted",
            meeting_id=msg.meeting_id,
            action_items=len(finalization.action_items),
            decisions=len(finalization.decisions),
            sentiment_scored=len(sentiment),
        )
    except Exception as err:
        db.fail_job(deps.conn, key, repr(err))
        raise


def make_on_exhausted(deps: Deps) -> Any:
    """Extraction is an enhancement, not part of the pipeline's terminal-
    status contract (D59) — a meeting that exhausts extraction retries stays
    `done`/`partial` from the stitcher's perspective; this just records the
    failure for the dashboard via a distinct extraction event."""

    def on_exhausted(payload: dict[str, Any], error: str, ctx: JobContext) -> None:
        tenant_id = payload.get("tenant_id")
        meeting_id = payload.get("meeting_id")
        if not isinstance(tenant_id, str) or not isinstance(meeting_id, str):
            return
        log.error("meeting.extraction_exhausted", meeting_id=meeting_id, error=error)
        ctx.publish_event(
            ExtractionEventV1(
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
        backend=create_extraction_backend(settings),
        rate_limited=True,
    )

    def handler(payload: dict[str, Any], ctx: JobContext) -> None:
        handle_meeting_extract(payload, ctx, deps)

    worker = Worker(settings, EXTRACTOR_QUEUE, handler, on_exhausted=make_on_exhausted(deps))
    worker.run()


if __name__ == "__main__":
    main()
