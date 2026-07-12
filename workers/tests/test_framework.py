"""Retry-ladder disposition tests: exercised through Worker._dispose_failed
with the broker ops stubbed out, so the policy (which tier, when to park,
when the exhausted hook runs) is tested without a live RabbitMQ."""

from __future__ import annotations

import functools
from typing import Any

import pytest

from scribeflow_workers.config import Settings
from scribeflow_workers.framework import PermanentError, Worker
from scribeflow_workers.topology import TRANSCRIBER_QUEUE


class Captured:
    def __init__(self) -> None:
        self.callbacks: list[functools.partial[None]] = []
        self.exhausted: list[tuple[dict[str, Any], str]] = []


@pytest.fixture()
def worker_and_captured(monkeypatch: pytest.MonkeyPatch) -> tuple[Worker, Captured]:
    captured = Captured()

    def on_exhausted(payload: dict[str, Any], error: str, _ctx: Any) -> None:
        captured.exhausted.append((payload, error))

    worker = Worker(
        Settings(), TRANSCRIBER_QUEUE, handler=lambda _p, _c: None, on_exhausted=on_exhausted
    )

    def fake_threadsafe(callback: functools.partial[None]) -> None:
        captured.callbacks.append(callback)

    monkeypatch.setattr(worker, "_threadsafe", fake_threadsafe)
    return worker, captured


def dispose(worker: Worker, prior_attempts: int, err: Exception) -> None:
    worker._dispose_failed(
        delivery_tag=1,
        body=b"{}",
        headers={},
        prior_attempts=prior_attempts,
        err=err,
        payload={"meeting_id": "m1"},
    )


def test_first_failure_goes_to_first_tier(
    worker_and_captured: tuple[Worker, Captured],
) -> None:
    worker, captured = worker_and_captured
    dispose(worker, prior_attempts=0, err=RuntimeError("boom"))
    (cb,) = captured.callbacks
    assert cb.func == worker._republish_retry
    # (delivery_tag, body, headers, attempts, tier_suffix)
    assert cb.args[3] == 1
    assert cb.args[4] == "30s"
    assert captured.exhausted == []


def test_third_failure_goes_to_last_tier(
    worker_and_captured: tuple[Worker, Captured],
) -> None:
    worker, captured = worker_and_captured
    dispose(worker, prior_attempts=2, err=RuntimeError("boom"))
    (cb,) = captured.callbacks
    assert cb.func == worker._republish_retry
    assert cb.args[4] == "10m"


def test_exhausted_parks_and_runs_hook(
    worker_and_captured: tuple[Worker, Captured],
) -> None:
    worker, captured = worker_and_captured
    dispose(worker, prior_attempts=3, err=RuntimeError("boom"))
    (cb,) = captured.callbacks
    assert cb.func == worker._park
    assert captured.exhausted == [({"meeting_id": "m1"}, "RuntimeError('boom')")]


def test_permanent_error_skips_the_ladder(
    worker_and_captured: tuple[Worker, Captured],
) -> None:
    worker, captured = worker_and_captured
    dispose(worker, prior_attempts=0, err=PermanentError("bad message"))
    (cb,) = captured.callbacks
    assert cb.func == worker._park
    assert len(captured.exhausted) == 1
