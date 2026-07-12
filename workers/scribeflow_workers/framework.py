"""Worker framework (ticket 1.3): consume → handle → ack, with the retry
ladder, structured logs, AMQP heartbeats during long jobs, and graceful
shutdown. Every pipeline worker is `Worker(queue_spec, handler)` + a pydantic
message model; the framework owns all broker mechanics.

Threading model: pika's BlockingConnection must only be touched from the
thread running `start_consuming()`, but a transcription job runs for minutes
— far past the heartbeat window. So each delivery is handled on a separate
thread while the connection thread keeps servicing heartbeats, and every
broker operation the handler needs (ack, retry republish, event publish) is
marshalled back via `add_callback_threadsafe`. Prefetch=1 per queue spec
means at most one in-flight job per worker process.

Failure semantics (D43): a failed message is republished to the retry queue
tier matching its attempt count (30s → 2m → 10m, carried in the x-attempts
header) and the original is acked. After MAX_ATTEMPTS total attempts the
message goes to q.parking with error context headers and the worker's
`on_exhausted` hook runs (e.g. mark the meeting failed). Handlers raising
PermanentError skip the ladder and park immediately.
"""

from __future__ import annotations

import functools
import json
import signal
import threading
from typing import Any, Callable, Protocol

import pika
from pika.adapters.blocking_connection import BlockingChannel
from pika.spec import Basic, BasicProperties

from .config import Settings
from .logging import get_logger
from .messages import StatusEventV1
from .topology import (
    EVENTS_EXCHANGE,
    PARKING_QUEUE,
    QueueSpec,
    declare_topology,
    retry_queue_name,
    retry_tier_for_attempt,
)

log = get_logger("framework")

ATTEMPTS_HEADER = "x-attempts"


class PermanentError(Exception):
    """Raise from a handler when retrying can never succeed (bad message,
    missing object) — goes straight to the parking lot."""


class JobContext(Protocol):
    def publish_event(self, event: StatusEventV1) -> None: ...


Handler = Callable[[dict[str, Any], JobContext], None]
ExhaustedHook = Callable[[dict[str, Any], str, JobContext], None]


class _Context:
    def __init__(self, worker: "Worker") -> None:
        self._worker = worker

    def publish_event(self, event: StatusEventV1) -> None:
        self._worker._publish_event_threadsafe(event)


class Worker:
    def __init__(
        self,
        settings: Settings,
        queue: QueueSpec,
        handler: Handler,
        on_exhausted: ExhaustedHook | None = None,
    ) -> None:
        self._settings = settings
        self._queue = queue
        self._handler = handler
        self._on_exhausted = on_exhausted
        self._connection: pika.BlockingConnection | None = None
        self._channel: BlockingChannel | None = None
        self._consumer_tag: str | None = None
        self._in_flight: threading.Thread | None = None
        self._stopping = False

    # -- lifecycle ----------------------------------------------------------

    def run(self) -> None:
        params = pika.URLParameters(self._settings.rabbitmq_url)
        params.heartbeat = 60
        self._connection = pika.BlockingConnection(params)
        self._channel = self._connection.channel()
        declare_topology(self._channel)
        self._channel.basic_qos(prefetch_count=self._queue.prefetch)
        self._consumer_tag = self._channel.basic_consume(
            queue=self._queue.name, on_message_callback=self._on_message
        )

        signal.signal(signal.SIGTERM, self._on_signal)
        signal.signal(signal.SIGINT, self._on_signal)

        log.info(
            "worker.started",
            queue=self._queue.name,
            prefetch=self._queue.prefetch,
        )
        try:
            self._channel.start_consuming()
        finally:
            if self._connection.is_open:
                self._connection.close()
            log.info("worker.stopped", queue=self._queue.name)

    def _on_signal(self, signum: int, _frame: Any) -> None:
        # Runs in the main (connection) thread between pika opcodes: safe to
        # touch the channel directly. Stop taking new deliveries; the
        # in-flight job (if any) finishes and its completion callback closes
        # the loop.
        if self._stopping:
            return
        self._stopping = True
        log.info("worker.shutdown_requested", signal=signum)
        channel = self._require_channel()
        if self._consumer_tag is not None:
            channel.basic_cancel(self._consumer_tag)
        if self._in_flight is None or not self._in_flight.is_alive():
            channel.stop_consuming()

    # -- message flow ---------------------------------------------------------

    def _on_message(
        self,
        _channel: BlockingChannel,
        method: Basic.Deliver,
        properties: BasicProperties,
        body: bytes,
    ) -> None:
        thread = threading.Thread(
            target=self._handle_delivery,
            args=(method, properties, body),
            daemon=False,
        )
        self._in_flight = thread
        thread.start()

    def _handle_delivery(
        self, method: Basic.Deliver, properties: BasicProperties, body: bytes
    ) -> None:
        headers: dict[str, Any] = dict(properties.headers or {})
        prior_attempts = int(headers.get(ATTEMPTS_HEADER, 0))
        delivery_tag = method.delivery_tag

        try:
            payload = json.loads(body)
            if not isinstance(payload, dict):
                raise PermanentError("message body is not a JSON object")
        except (json.JSONDecodeError, PermanentError) as err:
            log.error("job.malformed", queue=self._queue.name, reason=str(err))
            self._threadsafe(
                functools.partial(self._park, delivery_tag, body, headers, str(err))
            )
            return

        log.info(
            "job.started",
            queue=self._queue.name,
            routing_key=method.routing_key,
            attempt=prior_attempts + 1,
        )
        try:
            self._handler(payload, _Context(self))
        except Exception as err:  # noqa: BLE001 — the ladder is the policy
            self._dispose_failed(delivery_tag, body, headers, prior_attempts, err, payload)
            return

        log.info("job.done", queue=self._queue.name, routing_key=method.routing_key)
        self._threadsafe(functools.partial(self._ack, delivery_tag))

    def _dispose_failed(
        self,
        delivery_tag: int,
        body: bytes,
        headers: dict[str, Any],
        prior_attempts: int,
        err: Exception,
        payload: dict[str, Any],
    ) -> None:
        attempts = prior_attempts + 1
        tier = None if isinstance(err, PermanentError) else retry_tier_for_attempt(attempts)
        if tier is not None:
            log.warning(
                "job.retry",
                queue=self._queue.name,
                attempt=attempts,
                retry_in=tier.suffix,
                error=repr(err),
            )
            self._threadsafe(
                functools.partial(
                    self._republish_retry, delivery_tag, body, headers, attempts, tier.suffix
                )
            )
            return

        log.error("job.exhausted", queue=self._queue.name, attempt=attempts, error=repr(err))
        if self._on_exhausted is not None:
            try:
                self._on_exhausted(payload, repr(err), _Context(self))
            except Exception:  # noqa: BLE001
                log.error("job.exhausted_hook_failed", exc_info=True)
        self._threadsafe(
            functools.partial(self._park, delivery_tag, body, headers, repr(err))
        )

    # -- broker ops (connection thread only) ---------------------------------

    def _ack(self, delivery_tag: int) -> None:
        self._require_channel().basic_ack(delivery_tag)
        self._finish_in_flight()

    def _republish_retry(
        self,
        delivery_tag: int,
        body: bytes,
        headers: dict[str, Any],
        attempts: int,
        tier_suffix: str,
    ) -> None:
        channel = self._require_channel()
        channel.basic_publish(
            exchange="",
            routing_key=retry_queue_name(self._queue.name, tier_suffix),
            body=body,
            properties=BasicProperties(
                delivery_mode=2,
                content_type="application/json",
                headers={**headers, ATTEMPTS_HEADER: attempts},
            ),
        )
        channel.basic_ack(delivery_tag)
        self._finish_in_flight()

    def _park(
        self, delivery_tag: int, body: bytes, headers: dict[str, Any], error: str
    ) -> None:
        channel = self._require_channel()
        channel.basic_publish(
            exchange="",
            routing_key=PARKING_QUEUE,
            body=body,
            properties=BasicProperties(
                delivery_mode=2,
                content_type="application/json",
                headers={
                    **headers,
                    "x-parked-from": self._queue.name,
                    "x-parked-error": error[:500],
                },
            ),
        )
        channel.basic_ack(delivery_tag)
        self._finish_in_flight()

    def _publish_event(self, event: StatusEventV1) -> None:
        self._require_channel().basic_publish(
            exchange=EVENTS_EXCHANGE,
            routing_key="",
            body=event.model_dump_json().encode(),
            properties=BasicProperties(delivery_mode=1, content_type="application/json"),
        )

    def _publish_event_threadsafe(self, event: StatusEventV1) -> None:
        self._threadsafe(functools.partial(self._publish_event, event))

    def _finish_in_flight(self) -> None:
        self._in_flight = None
        if self._stopping:
            self._require_channel().stop_consuming()

    def _threadsafe(self, callback: Callable[[], None]) -> None:
        connection = self._connection
        if connection is None:
            raise RuntimeError("worker is not connected")
        connection.add_callback_threadsafe(callback)

    def _require_channel(self) -> BlockingChannel:
        if self._channel is None:
            raise RuntimeError("worker is not connected")
        return self._channel
