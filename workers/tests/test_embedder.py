"""Embedder handler tests (ticket 3.5): full handler flow with fakes for the
db and the embedding backend — no model load, per CLAUDE.md."""

from __future__ import annotations

from typing import Any

import pytest

from scribeflow_workers import db as db_module
from scribeflow_workers import embedder
from scribeflow_workers.config import Settings
from scribeflow_workers.db import EmbeddingSegmentRow
from scribeflow_workers.framework import PermanentError

TENANT = "11111111-1111-4111-8111-111111111111"
MEETING = "22222222-2222-4222-8222-222222222222"


def payload(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {"v": 1, "tenant_id": TENANT, "meeting_id": MEETING}
    base.update(overrides)
    return base


class FakeCtx:
    def publish_event(self, event: Any) -> None:
        raise AssertionError("embedder never publishes events")

    def publish(self, routing_key: str, message: Any) -> None:
        raise AssertionError("embedder never publishes jobs")


class FakeBackend:
    def __init__(self, vectors: dict[str, list[float]] | None = None) -> None:
        self.vectors = vectors or {}
        self.calls: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(texts)
        return [self.vectors.get(t, [0.0, 0.0]) for t in texts]


class DbCalls:
    def __init__(self) -> None:
        self.claim_result = True
        self.segments: list[EmbeddingSegmentRow] = []
        self.written: list[tuple[str, list[float]]] = []
        self.completed: list[str] = []
        self.failed: list[tuple[str, str]] = []


@pytest.fixture()
def db_calls(monkeypatch: pytest.MonkeyPatch) -> DbCalls:
    calls = DbCalls()
    monkeypatch.setattr(
        db_module, "claim_job", lambda conn, t, m, k, s: calls.claim_result
    )
    monkeypatch.setattr(
        db_module, "get_segments_for_embedding", lambda conn, m: calls.segments
    )

    def fake_write(conn: Any, embeddings: list[tuple[str, list[float]]]) -> None:
        calls.written.extend(embeddings)

    monkeypatch.setattr(db_module, "write_embeddings", fake_write)
    monkeypatch.setattr(
        db_module, "complete_job", lambda conn, key: calls.completed.append(key)
    )
    monkeypatch.setattr(
        db_module, "fail_job", lambda conn, key, error: calls.failed.append((key, error))
    )
    return calls


class FakeConn:
    def __init__(self) -> None:
        self.rollback_calls = 0

    def rollback(self) -> None:
        self.rollback_calls += 1


def make_deps(conn: Any = None, backend: Any = None) -> embedder.Deps:
    return embedder.Deps(
        settings=Settings(),
        conn=conn if conn is not None else FakeConn(),
        backend=backend if backend is not None else FakeBackend(),
    )


def test_empty_transcript_skips_the_model_and_completes(db_calls: DbCalls) -> None:
    db_calls.segments = []
    backend = FakeBackend()
    embedder.handle_meeting_embed(payload(), FakeCtx(), make_deps(backend=backend))

    assert backend.calls == []
    assert db_calls.written == []
    assert db_calls.completed == [f"{MEETING}:embed:0"]


def test_happy_path_embeds_every_segment_in_one_call(db_calls: DbCalls) -> None:
    db_calls.segments = [
        EmbeddingSegmentRow(id="s0", text="let's ship by friday"),
        EmbeddingSegmentRow(id="s1", text="sounds good"),
    ]
    backend = FakeBackend(
        {"let's ship by friday": [0.1, 0.2], "sounds good": [0.3, 0.4]}
    )
    embedder.handle_meeting_embed(payload(), FakeCtx(), make_deps(backend=backend))

    (call,) = backend.calls
    assert call == ["let's ship by friday", "sounds good"]
    assert db_calls.written == [("s0", [0.1, 0.2]), ("s1", [0.3, 0.4])]
    assert db_calls.completed == [f"{MEETING}:embed:0"]
    assert db_calls.failed == []


def test_already_done_job_is_skipped(db_calls: DbCalls) -> None:
    db_calls.claim_result = False
    backend = FakeBackend()
    embedder.handle_meeting_embed(payload(), FakeCtx(), make_deps(backend=backend))

    assert backend.calls == []
    assert db_calls.completed == []


def test_invalid_message_raises_permanent_error() -> None:
    with pytest.raises(PermanentError):
        embedder.handle_meeting_embed({"v": 1}, FakeCtx(), make_deps())


def test_backend_failure_fails_the_job_and_rolls_back(db_calls: DbCalls) -> None:
    db_calls.segments = [EmbeddingSegmentRow(id="s0", text="hello")]

    class BoomBackend:
        def embed(self, texts: list[str]) -> list[list[float]]:
            raise RuntimeError("model exploded")

    conn = FakeConn()
    with pytest.raises(RuntimeError):
        embedder.handle_meeting_embed(
            payload(), FakeCtx(), make_deps(conn=conn, backend=BoomBackend())
        )

    assert conn.rollback_calls == 1
    (failure,) = db_calls.failed
    assert failure[0] == f"{MEETING}:embed:0"
