# ScribeFlow

**A self-hosted meeting chief-of-staff agent** — a free, self-operated alternative to
Read.ai / Fireflies. A bot joins your Google Meet calls, records the audio,
transcribes it with speaker diarization, extracts action items with an LLM, and
surfaces team analytics on a real-time dashboard. Then the agent layer makes the
team more productive: chat with your entire meeting history ("what did we decide
about pricing last month?"), get human-approved follow-up drafts after every
meeting, and automatic nudges when action items go stale.

- **Live at:** `https://scribeflow.deepcoomer.dev` (app) · `https://scribeflow-api.deepcoomer.dev` (API)
- **Operating cost:** $0/month (see [docs/infrastructure.md](docs/infrastructure.md))
- **Status:** planning — see [docs/plan.md](docs/plan.md)

## Why this project

It is an intensive asynchronous data-pipeline build that demonstrates senior-level
backend depth: queue design, media processing, concurrent fan-out/fan-in with
deterministic merging, columnar analytics, and multi-tenant isolation — not another
CRUD app.

## The 30-second architecture

```
Google Calendar ──webhook──▶ Scheduler ──▶ Meet Bot (Playwright + PulseAudio, Docker)
                                                │ records audio
                                                ▼
                     Cloudflare R2 (S3-compatible, presigned upload)
                                                │ enqueue
                                                ▼
             RabbitMQ ──▶ Python workers:  ffmpeg slice ─▶ parallel Whisper (Groq)
                                           pyannote diarization (full file)
                                           deterministic stitch + speaker merge
                                                │
                                ┌───────────────┴───────────────┐
                                ▼                               ▼
                        Postgres (meetings,             ClickHouse (utterances,
                        action items, tenants)          talk-time, sentiment)
                                └───────────────┬───────────────┘
                                                ▼
                          Node.js API (Fastify) ──SSE──▶ React dashboard
```

## Core design decisions

1. **Never process media in the API server.** Uploads go straight to R2 via presigned
   URLs; the API only enqueues jobs.
2. **The racing engine.** Audio is sliced into ~5-minute chunks with overlap and
   transcribed concurrently; transcripts are stitched back deterministically using
   timestamp offsets. Diarization runs _once_ on the full file (speaker clustering is
   global) and is merged with the stitched transcript by temporal overlap.
3. **ClickHouse for analytics, Postgres for state.** Utterance-level rows go to
   ClickHouse so talk-time ratios, interruption counts, and sentiment-over-time stay
   fast at millions of rows.
4. **Multi-tenant from day one.** Every row carries `tenant_id`; scoping is enforced
   in one middleware layer, not per-handler.

## Documentation

| Doc                                              | Contents                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| [docs/plan.md](docs/plan.md)                     | Feasibility verdict, phased roadmap, ticket list with model assignments                |
| [docs/decisions.md](docs/decisions.md)           | Numbered decision log (D1–D41): every choice, its reasoning, and rejected alternatives |
| [docs/architecture.md](docs/architecture.md)     | Full system design: pipeline, racing engine, schemas, tenancy                          |
| [docs/infrastructure.md](docs/infrastructure.md) | Free-tier hosting plan, DNS/subdomains, cost table, fallbacks                          |
| [docs/meet-bot.md](docs/meet-bot.md)             | Google Meet bot design (Playwright + virtual audio), Zoom later                        |
| [docs/model-strategy.md](docs/model-strategy.md) | Which Claude Code model to use for which tickets, and why                              |

## Naming

The name **ScribeFlow** stays: it says what the product does (scribe) and how it does
it (an async flow/pipeline), and it's clean as a subdomain. Alternatives considered
(Debrief, EchoNote, Minutable) were either taken as products or less descriptive.
