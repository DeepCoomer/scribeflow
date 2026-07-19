"""Embedding backend for the embedder worker (ticket 3.5, D63): local CPU
sentence-transformers, behind a Protocol so tests run against a fake — no
model load in CI, same shape as extract_backends.py/transcribe_backends.py.
"""

from __future__ import annotations

from typing import Protocol

from .config import Settings


class EmbeddingBackend(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]:
        """One embedding vector per input text, same order, L2-normalized
        (so pgvector's `<=>` cosine-distance operator and a plain dot
        product agree)."""
        ...


class SentenceTransformerBackend:
    def __init__(self, settings: Settings) -> None:
        # Imported lazily: this pulls in torch, same reasoning as
        # PyannoteBackend's lazy import (workers/Dockerfile always installs
        # the `embed` extra, but the module import cost is worth deferring
        # past process startup for every other worker importing this file's
        # types).
        from sentence_transformers import SentenceTransformer

        self._model = SentenceTransformer(settings.embedding_model)

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        vectors = self._model.encode(texts, normalize_embeddings=True)
        return [v.tolist() for v in vectors]


def create_embedding_backend(settings: Settings) -> EmbeddingBackend:
    return SentenceTransformerBackend(settings)
