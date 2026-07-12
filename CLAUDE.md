# CLAUDE.md

ScribeFlow is a self-hosted, $0/month meeting chief-of-staff agent: a bot joins
Google Meet calls, an async pipeline transcribes (Groq Whisper) + diarizes
(pyannote) the audio, an LLM extracts action items and summaries (delivered via
dashboard + approval-gated email), and an agent layer provides RAG chat over
meeting history, follow-up drafts, and action-item nudges.

**Status: Phase 1 code complete** (upload→R2→queue→transcribe→SSE→viewer;
tickets 1.1–1.6). Remaining in Phase 1: the manual go-live steps 1.7 (Vercel)
and 1.8 (Oracle VM + DNS). Next: Phase 2 per `docs/plan.md`. The design in
`docs/` is authoritative — read the relevant doc before implementing, and
update it when reality diverges.

## Read this first, per task

| Working on…                                                     | Read                     |
| --------------------------------------------------------------- | ------------------------ |
| Any ticket (find it + its assigned model)                       | `docs/plan.md`           |
| Pipeline, queue, schemas, racing engine, tenancy                | `docs/architecture.md`   |
| Deploy, DNS, free-tier limits, RAM budget, secrets              | `docs/infrastructure.md` |
| Meet bot, orchestrator, audio capture                           | `docs/meet-bot.md`       |
| Which Claude model runs which ticket                            | `docs/model-strategy.md` |
| Why anything was chosen / before proposing a different approach | `docs/decisions.md`      |

Before deviating from a documented choice, check `docs/decisions.md` — the
alternative you're about to propose was probably already rejected for a reason.
If a deviation is still right, add a new D-entry (mark the old one SUPERSEDED)
in the same PR.

## Repo layout (target)

```
api/       Node 22 + TypeScript + Fastify + Zod (multi-tenant REST + SSE)
web/       React + Vite dashboard (static, deployed to Vercel)
workers/   Python 3.12 pipeline workers (slicer, transcriber, diarizer,
           stitcher, extractor, embedder)
bot/       Playwright Meet bot (runs inside its own Docker image) + orchestrator
infra/     Docker Compose, Caddy ingress config, provisioning runbook
docs/      the design docs above — keep in sync with code
```

pnpm workspaces for JS/TS; `uv` for Python. One ticket per session; reference the
ticket ID and the relevant doc section in your work.

## Invariants — never violate these

1. **The API never touches media bytes.** Uploads go client→R2 via presigned URLs;
   the API only mints URLs and enqueues jobs.
2. **Every DB access is tenant-scoped.** Repository functions take `tenantId` as a
   required parameter — no defaults, no "admin" bypass helpers. R2 keys are
   prefixed `tenant/{tenantId}/`. Analytics aggregates use the same repository
   pattern — no separate query path that could skip scoping.
3. **Jobs are idempotent.** Deterministic job IDs (`{meetingId}:{stage}:{chunkIdx}`),
   upsert-only writes, safe under RabbitMQ redelivery. Fan-in uses the atomic
   `chunks_done` counter — never a distributed lock.
4. **Timestamps are absolute meeting time.** Chunk workers shift by `offset_s`
   before persisting; nothing downstream ever sees chunk-relative time.
5. **Diarization is never chunked** (global speaker clustering); transcription is
   always chunked. They run in parallel and merge at the stitcher.
6. **Stay inside free tiers.** Groq calls go through the shared rate limiter
   (20 req/min); respect the RAM budget in `docs/infrastructure.md` (12 GB total,
   max 1 concurrent bot container); R2 lifecycle deletes raw audio after 30 days.
7. **The bot is always visible and named** ("ScribeFlow Notetaker"), never hidden.
   The follow-up agent drafts; a human approves — it never auto-sends.
8. **Secrets** live only in the VM's `.env` (git-ignored); every new variable gets
   a documented entry in `.env.example` in the same PR. Nothing secret in `web/`.

## Conventions

- TypeScript: strict mode, Zod validation at every API boundary, no `any`.
- Python: type hints + `pydantic` models for every queue message; queue message
  schemas are the contract between services — change them only with a versioned
  field, never in place.
- Errors: workers nack to DLQ with structured context; never swallow exceptions.
- Tests: every pipeline stage gets a unit test with recorded fixtures (no live
  Groq calls in CI); the stitcher and rate limiter get property-style tests.
- Commits: conventional commits (`feat(workers): …`), one ticket per PR.

## Commands

```sh
pnpm install                                  # all JS/TS workspaces
docker compose -f infra/compose.yml up -d postgres rabbitmq
pnpm --filter @scribeflow/api db:generate     # after schema.ts changes
pnpm --filter @scribeflow/api db:migrate
pnpm dev:api                                  # API on :3000 (PORT=… to override)
pnpm --filter @scribeflow/web dev             # dashboard on :5173
pnpm lint && pnpm format && pnpm typecheck    # what CI runs
pnpm test                                     # needs the compose Postgres up + migrated
cd workers && uv sync && uv run pytest        # Python side (Phase 1+)
```

Local gotchas: compose Postgres maps to host port **55432** (5432 is often taken
by a local install); `api/.env` comes from `api/.env.example` and already points
there. Never start the `caddy` service locally — it binds 80/443 and requests
real certificates (VM-only, see `infra/README.md`).

## Definition of done for a ticket

Code + tests pass locally, invariants above hold, the relevant `docs/` section is
updated if behavior diverged from design, any new or changed decision is logged in
`docs/decisions.md` with a D-number, `.env.example` updated if config was added,
and `docs/plan.md` ticket table stays accurate if scope changed.
