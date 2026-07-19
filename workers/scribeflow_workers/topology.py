"""RabbitMQ topology (ticket 1.2) — exact mirror of api/src/queue/topology.ts.

Both sides declare idempotently on connect; see the TS file for the full
layout rationale. If you change anything here, change it there in the same
commit — the declarations must stay byte-compatible or asserts will fail
with PRECONDITION_FAILED at boot (which is the point: drift fails loudly).
"""

from __future__ import annotations

from dataclasses import dataclass

from pika.adapters.blocking_connection import BlockingChannel

PIPELINE_EXCHANGE = "pipeline"
EVENTS_EXCHANGE = "events"

MEETING_UPLOADED = "meeting.uploaded"
CHUNK_TRANSCRIBE = "chunk.transcribe"
MEETING_DIARIZE = "meeting.diarize"
MEETING_STITCH = "meeting.stitch"
MEETING_EXTRACT = "meeting.extract"
MEETING_EMBED = "meeting.embed"

PARKING_QUEUE = "q.parking"


@dataclass(frozen=True)
class RetryTier:
    suffix: str
    ttl_ms: int


RETRY_TIERS: tuple[RetryTier, ...] = (
    RetryTier("30s", 30_000),
    RetryTier("2m", 120_000),
    RetryTier("10m", 600_000),
)

# 1 initial attempt + one per retry tier, then the parking lot.
MAX_ATTEMPTS = 1 + len(RETRY_TIERS)


@dataclass(frozen=True)
class QueueSpec:
    name: str
    bindings: tuple[str, ...]
    prefetch: int = 1


def retry_queue_name(queue: str, tier_suffix: str) -> str:
    return f"{queue}.retry.{tier_suffix}"


# Phase 2 (D45 realized): the slicer now owns meeting.uploaded; a job is a
# whole meeting's ffmpeg work, so prefetch stays 1. The transcriber moves to
# chunk.transcribe with prefetch 4 (IO-bound, competing consumers per
# docs/architecture.md); the diarizer is CPU-bound so prefetch stays 1.
SLICER_QUEUE = QueueSpec(name="q.slicer", bindings=(MEETING_UPLOADED,))
TRANSCRIBER_QUEUE = QueueSpec(name="q.transcriber", bindings=(CHUNK_TRANSCRIBE,), prefetch=4)
DIARIZER_QUEUE = QueueSpec(name="q.diarizer", bindings=(MEETING_DIARIZE,))
STITCHER_QUEUE = QueueSpec(name="q.stitcher", bindings=(MEETING_STITCH,))
# Phase 3 (3.1/3.2, D59): one big job per meeting (action items + summary +
# batched sentiment), same shape as the stitcher — prefetch 1 is fine since
# the shared Groq rate limiter (D24) is the actual concurrency control.
EXTRACTOR_QUEUE = QueueSpec(name="q.extractor", bindings=(MEETING_EXTRACT,))
# Ticket 3.5 (D63): embeds every transcript segment, one job per meeting,
# published by the stitcher alongside meeting.extract — runs in parallel
# with extraction (invariant 5's "parallel, independent finalize" shape),
# not as part of the same job, so a slow/failed embed never blocks or
# retries the intelligence pass.
EMBEDDER_QUEUE = QueueSpec(name="q.embedder", bindings=(MEETING_EMBED,))

WORK_QUEUES: tuple[QueueSpec, ...] = (
    SLICER_QUEUE,
    TRANSCRIBER_QUEUE,
    DIARIZER_QUEUE,
    STITCHER_QUEUE,
    EXTRACTOR_QUEUE,
    EMBEDDER_QUEUE,
)


def declare_topology(channel: BlockingChannel) -> None:
    channel.exchange_declare(PIPELINE_EXCHANGE, exchange_type="topic", durable=True)
    channel.exchange_declare(EVENTS_EXCHANGE, exchange_type="fanout", durable=True)

    for spec in WORK_QUEUES:
        # Quorum work queue; a bare nack (bypassing the framework's explicit
        # retry republish) still dead-letters to the first retry tier.
        channel.queue_declare(
            spec.name,
            durable=True,
            arguments={
                "x-queue-type": "quorum",
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": retry_queue_name(
                    spec.name, RETRY_TIERS[0].suffix
                ),
            },
        )
        for binding in spec.bindings:
            channel.queue_bind(spec.name, PIPELINE_EXCHANGE, routing_key=binding)
        for tier in RETRY_TIERS:
            # TTL expiry dead-letters straight back to the work queue by
            # name (default exchange), independent of topic bindings.
            channel.queue_declare(
                retry_queue_name(spec.name, tier.suffix),
                durable=True,
                arguments={
                    "x-message-ttl": tier.ttl_ms,
                    "x-dead-letter-exchange": "",
                    "x-dead-letter-routing-key": spec.name,
                },
            )

    channel.queue_declare(
        PARKING_QUEUE, durable=True, arguments={"x-queue-type": "quorum"}
    )

    # Phase 1->2 migration (D45): q.transcriber used to bind meeting.uploaded
    # directly. RabbitMQ never drops a binding just because the code stopped
    # asserting it, so a broker that already ran Phase 1 keeps delivering
    # meeting.uploaded to q.transcriber alongside the new chunk.transcribe
    # binding unless it's explicitly removed. Unbinding a binding that isn't
    # there (a fresh broker) is a no-op, so this is safe to run forever.
    channel.queue_unbind(
        TRANSCRIBER_QUEUE.name, PIPELINE_EXCHANGE, routing_key=MEETING_UPLOADED
    )


def retry_tier_for_attempt(attempt: int) -> RetryTier | None:
    """Tier for a message that has now failed `attempt` times (1-based);
    None means the retries are exhausted and it belongs in the parking lot."""
    index = attempt - 1
    if 0 <= index < len(RETRY_TIERS):
        return RETRY_TIERS[index]
    return None
