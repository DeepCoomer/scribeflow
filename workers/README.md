# workers

Python 3.12 pipeline workers (managed with `uv`). Phase 1 ships the shared
worker framework plus the single-shot transcriber; the slicer, diarizer,
stitcher, and extractor land in Phases 2–3 on the same framework. See
[docs/plan.md](../docs/plan.md) and
[docs/architecture.md](../docs/architecture.md#queue-topology).

## Layout

- `scribeflow_workers/framework.py` — consume → handle → ack loop: retry
  ladder (D43), structured JSON logs, AMQP heartbeats during long jobs,
  graceful shutdown (ticket 1.3)
- `scribeflow_workers/topology.py` — RabbitMQ topology, exact mirror of
  `api/src/queue/topology.ts` (ticket 1.2)
- `scribeflow_workers/messages.py` — pydantic queue-message schemas (the
  contract with the API)
- `scribeflow_workers/transcriber.py` — meeting.uploaded → R2 download →
  Whisper backend → transcript_segments (ticket 1.4)
- `scribeflow_workers/transcribe_backends.py` — `TRANSCRIBE_BACKEND=groq|local`
  switch (D22)
- `scribeflow_workers/rate_limiter.py` — shared Groq token bucket in
  Postgres (D24)

## Running

```sh
uv sync                                   # once
cp .env.example .env                      # fill in R2 + Groq secrets
uv run python -m scribeflow_workers.transcriber
```

Tests use recorded fixtures — no live Groq/R2/broker needed:

```sh
uv run pytest && uv run ruff check . && uv run mypy .
```
