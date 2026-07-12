# Multi-arch (runs on the Oracle Ampere ARM VM and x86 dev machines).
# One image serves every pipeline worker; compose picks the entrypoint
# module per service (Phase 1: only the transcriber).
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:0.5 /uv /uvx /bin/

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Dependency layer first so code edits don't re-resolve the lockfile.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY scribeflow_workers ./scribeflow_workers
RUN uv sync --frozen --no-dev

CMD ["uv", "run", "--no-sync", "python", "-m", "scribeflow_workers.transcriber"]
