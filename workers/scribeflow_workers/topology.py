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


# Phase 1 (D45): the single-shot transcriber consumes meeting.uploaded
# directly; a job is a whole meeting (minutes of work), so prefetch stays 1.
# Phase 2 moves this binding to q.slicer, binds chunk.transcribe here, and
# raises prefetch to 4 per docs/architecture.md.
TRANSCRIBER_QUEUE = QueueSpec(name="q.transcriber", bindings=(MEETING_UPLOADED,))

WORK_QUEUES: tuple[QueueSpec, ...] = (TRANSCRIBER_QUEUE,)


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


def retry_tier_for_attempt(attempt: int) -> RetryTier | None:
    """Tier for a message that has now failed `attempt` times (1-based);
    None means the retries are exhausted and it belongs in the parking lot."""
    index = attempt - 1
    if 0 <= index < len(RETRY_TIERS):
        return RETRY_TIERS[index]
    return None
