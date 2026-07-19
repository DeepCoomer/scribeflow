# Multi-arch (runs on the Oracle Ampere ARM VM and x86 dev machines).
# One image serves every pipeline worker; compose picks the entrypoint
# module per service (Phase 2: slicer, transcriber, diarizer, stitcher).
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Dependency layer first so code edits don't re-resolve the lockfile. The
# `diarize` extra (pyannote.audio + torch) only runs in the diarizer
# container, and `embed` (sentence-transformers + torch, ticket 3.5) only
# runs in the embedder container, but one shared image is simpler than a
# third Dockerfile — see the RAM budget in docs/infrastructure.md for what
# this costs at rest.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev --extra diarize --extra embed

COPY scribeflow_workers ./scribeflow_workers
RUN uv sync --frozen --no-dev --extra diarize --extra embed

CMD ["uv", "run", "--no-sync", "python", "-m", "scribeflow_workers.transcriber"]
