# ScribeFlow — Master Plan

_Last updated: 2026-07-18_

## 1. Feasibility verdict: yes, $0/month is realistic

Every component has a free tier or self-hosted path that covers portfolio/small-team
scale (a handful of meetings per day):

| Need                                           | Free solution                                                    | Limit that matters                                      |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| Compute (API, queue, DB, workers, bot)         | Oracle Cloud Always Free ARM VM                                  | 2 OCPU / 12 GB RAM (reduced from 4/24 in June 2026)     |
| Transcription                                  | Groq free tier, `whisper-large-v3-turbo` (your existing key)     | ~2 h of audio per clock-hour; 2,000 req/day; 100 MB/req |
| Action-item extraction + summaries + sentiment | Groq free tier, `llama-3.3-70b-versatile` (same key)             | rate limits generous for batch use                      |
| Diarization                                    | pyannote 3.x, self-hosted on CPU                                 | ~real-time speed on ARM CPU; fine async                 |
| Object storage                                 | Cloudflare R2                                                    | 10 GB free, zero egress fees                            |
| Frontend hosting                               | Vercel Hobby (D40)                                               | non-commercial use; fine for a portfolio                |
| DNS + TLS                                      | records at existing provider; Vercel + Caddy/Let's Encrypt (D39) | free                                                    |
| Calendar integration                           | Google Calendar API                                              | free quota is ample                                     |

Risks to the $0 claim (all have fallbacks, see [infrastructure.md](infrastructure.md)):
Oracle free-tier signup can be finicky and was just downsized; if it fails entirely,
the fallback is a Hetzner CAX11 ARM VM (~€4/mo) or running the heavy pieces on your
own Mac behind a free tunnel (Cloudflare/Tailscale). Development cost is your
existing Claude Code subscription.

## 2. Scope

**In (v1):** Google Meet bot, upload-a-file path, async pipeline (slice → parallel
Whisper → diarize → stitch → extract), multi-tenant API + dashboard (transcripts,
summaries, action items; post-meeting summary email), Google Calendar auto-join,
and the **agent layer** — RAG chat over all meeting history, human-approved
follow-up drafts, and action-item nudges. The agent layer is what makes the "AI
agent" claim real: the bot perceives the calendar and acts autonomously, and the
agent tracks the commitments made in meetings until they're done.

**Out (v1):** Zoom/Teams (Phase 8 stretch), team analytics dashboard + ClickHouse
(Phase 4 stretch, D42), real-time in-meeting transcription, mobile apps, billing.

## 3. Phased roadmap with tickets

Each ticket is tagged with the Claude Code model to run it with — rationale in
[model-strategy.md](model-strategy.md). Rule of thumb (D41): **Sonnet is the
default**, Opus for concurrency/queue/analytics-heavy implementation and
mid-project code reviews, Fable only as the **spec-writer** (turning a phase's
goals into detailed, decided tickets before cheaper models execute) plus two
carve-outs: the final security review (7.1) and rescue when a cheaper model
loops on the same bug across sessions.

### Phase 0 — Foundation (repo, infra, walking skeleton)

| #   | Ticket                                                                                                                                                               | Model     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 0.1 | Monorepo scaffold (pnpm workspaces: `api/`, `web/`, `workers/`, `bot/`, `infra/`), lint, CI                                                                          | Sonnet    |
| 0.2 | Docker Compose for Postgres + RabbitMQ + Caddy ingress (config only — actual VM provisioning deferred to 1.8, D39; ClickHouse was included here then removed by D42) | Sonnet    |
| 0.3 | Hosting/DNS decision + docs: `scribeflow.deepcoomer.dev` (Vercel, D40), `scribeflow-api.deepcoomer.dev` (A record → VM, Caddy TLS) — records created at 1.7/1.8      | Sonnet    |
| 0.4 | Postgres schema v1 + migrations (tenants, users, meetings, jobs, action_items)                                                                                       | Sonnet    |
| 0.5 | Fastify API skeleton: health, auth (email+password + Google OAuth), tenant middleware                                                                                | Sonnet    |
| 0.6 | Review of tenancy model & schema before anything builds on it                                                                                                        | **Fable** |

### Phase 1 — Upload → transcript MVP (no bot yet)

_Status: 1.1–1.6 **done and verified end-to-end** (July 2026), including 4
bugs found and fixed via live testing (login-redirect hash trap, SSE CORS
bypass on the hijacked response, worker connection-poisoning on failure,
`claim_job` enum-cast mismatch). **1.7 done** — live at
`scribeflow.deepcoomer.dev`. **1.8 blocked** on Always Free Ampere capacity
in `AP-MUMBAI-1` (account signup itself is resolved; see
`docs/oracle-vm-setup.md` for the exact config queued up for whenever
capacity frees). Implementation notes: retry ladder D43, SSE token auth
D44, interim `meeting.uploaded` → `q.transcriber` binding D45; the D22
`TRANSCRIBE_BACKEND=groq|local` switch shipped with 1.4 as planned._

| #   | Ticket                                                                                                                                                                                                                                                                                                       | Model           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------- |
| 1.1 | R2 presigned upload endpoint + client; enqueue `meeting.uploaded` on completion                                                                                                                                                                                                                              | Sonnet          |
| 1.2 | RabbitMQ topology: exchanges, queues, DLQ, retry policy, idempotent consumers                                                                                                                                                                                                                                | **Opus**        |
| 1.3 | Python worker framework: consume, heartbeat, ack/nack, structured logs, graceful shutdown                                                                                                                                                                                                                    | **Opus**        |
| 1.4 | Single-shot transcription worker: download from R2 → Groq Whisper → store segments                                                                                                                                                                                                                           | Sonnet          |
| 1.5 | Transcript viewer page (read-only, segment list with timestamps)                                                                                                                                                                                                                                             | Sonnet          |
| 1.6 | Job status via SSE (`processing → transcribing → done`)                                                                                                                                                                                                                                                      | Sonnet          |
| 1.7 | **Go live (web):** connect repo to Vercel, root dir `web/`, add `scribeflow.deepcoomer.dev` + CNAME at the registrar. Manual, ~10 min — can be done any time from now                                                                                                                                        | Manual          |
| 1.8 | **Go live (API):** provision Oracle VM (manual signup — start early, capacity is flaky), A record `scribeflow-api.deepcoomer.dev` → VM IP, open 443 in Oracle security list **and** ufw, `docker compose up`, verify `https://…/health`. Do this at the end of Phase 1, when there's a real pipeline to host | Manual + Sonnet |

> **When to host:** 1.7 (Vercel) whenever you like — it's ten minutes. 1.8 (Oracle
> VM + API DNS) belongs at the **end of Phase 1**: before that there is nothing to
> deploy but a health check. Exception: do the Oracle account **signup** early,
> since Always Free capacity can take days of retries.

### Phase 2 — The racing engine + diarization (the hard core)

_Status: 2.1 **done** (2026-07-18) — the racing-engine edge cases are fully
specified in architecture.md ("Slicing" through "Fan-in mechanics") with
decisions D46–D50 (chunk-count formula, always-FLAC re-encode + chunk objects
in R2, hallucination filter, `exhausted` job state + `transcript_gaps`,
exactly-once fan-in + crash-window closures). **2.2–2.5 done** (2026-07-19) —
slicer, chunk transcriber, stitcher, and diarizer all implemented, tested
(fixtures/fakes only — no live Groq or pyannote calls), and lint/typecheck/
pytest all green; decisions D51–D54 cover what came up during implementation
(generic job-publish primitive, pyannote as an optional dependency, the
live-topology-rebind unbind requirement, and the present-neighbor refinement
to the stitch dedup rule). Deviation from the model-strategy table: 2.2–2.5
were run as **Sonnet** in one combined session by explicit user request,
not Opus/one-ticket-per-session as originally planned — noted here rather
than changing the table, since Opus stays the default for this shape of
ticket going forward. Next: 2.6 (speaker merge, Fable design → Opus impl),
2.7 (chaos tests, Opus), 2.8 (pipeline code review, Opus, D41)._

| #   | Ticket                                                                                                                                                              | Model                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 2.1 | Design doc: chunking strategy (5-min chunks, 10 s overlap), deterministic stitch algorithm, overlap dedup rules, edge cases (silence, mid-word cuts, chunk failure) | **Fable**                        |
| 2.2 | ffmpeg slicer worker: split with overlap, emit chunk jobs with offsets, fan-out counter                                                                             | **Opus**                         |
| 2.3 | Chunk transcriber: Groq Whisper per chunk (parallel, rate-limit-aware), timestamp shift                                                                             | **Opus**                         |
| 2.4 | Stitcher (fan-in reducer): triggers when all chunks land, dedupes overlaps, produces final transcript                                                               | **Opus**                         |
| 2.5 | pyannote diarization worker on full file (runs in parallel with 2.2–2.4)                                                                                            | Sonnet                           |
| 2.6 | Speaker–transcript merge: assign speaker to each segment by max temporal overlap; map diarized speakers to calendar attendee names                                  | **Fable** (design) → Opus (impl) |
| 2.7 | Pipeline chaos tests: kill a worker mid-chunk, duplicate deliveries, out-of-order completion                                                                        | **Opus**                         |
| 2.8 | Code review of the whole pipeline before Phase 3                                                                                                                    | **Opus** (D41)                   |

### Phase 3 — Intelligence layer

| #   | Ticket                                                                                                                                                   | Model    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 3.1 | Prompt + extraction worker: action items (owner, due date, confidence), decisions, summary via Groq LLM; strict JSON schema output with retry-on-invalid | **Opus** |
| 3.2 | Per-utterance sentiment scoring (batched LLM calls)                                                                                                      | Sonnet   |
| 3.3 | Action-items UI: list, assign, mark done, link to transcript timestamp                                                                                   | Sonnet   |
| 3.4 | Meeting summary email (optional, via free Resend tier or skip)                                                                                           | Sonnet   |

### Phase 3b — Agent layer ("meeting chief of staff")

| #   | Ticket                                                                                                                                                                                   | Model    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 3.5 | Embeddings: pgvector + sentence-transformers (CPU, free) worker embedding every transcript segment on finalize                                                                           | Sonnet   |
| 3.6 | "Ask your meetings" RAG chat: retrieval (pgvector) + Groq LLM answer with citations linking to meeting + timestamp; SSE-streamed                                                         | **Opus** |
| 3.7 | Follow-up agent: after each meeting, draft a follow-up email (summary + action items per owner) shown in dashboard for one-click approve/edit/send — human-in-the-loop, never auto-sends | Sonnet   |
| 3.8 | Nudge agent: daily cron scans open action items past due, notifies owners (dashboard + optional email digest)                                                                            | Sonnet   |

### Phase 4 (stretch) — Team analytics dashboard (D42)

Deferred behind the bot and agent layer: the v1 product (transcript, summary,
action items, agent) never reads these aggregates. Analytics are served from
**Postgres** — at portfolio scale utterances number in the thousands and
aggregate instantly; the retained ClickHouse design (D17/D18) is the documented
scale-out path if that ever changes.

| #   | Ticket                                                                                                       | Model  |
| --- | ------------------------------------------------------------------------------------------------------------ | ------ |
| 4.1 | Postgres `utterance_metrics` (talk seconds, interruptions, sentiment per speaker/meeting), written at stitch | Sonnet |
| 4.2 | Analytics API endpoints (aggregations per-team, per-person, time-windowed) over Postgres                     | Sonnet |
| 4.3 | Dashboard: charts for talk-time, interruption matrix, sentiment timeline, meeting load                       | Sonnet |

### Phase 5 — Google Meet bot (the flagship)

| #   | Ticket                                                                                                                                 | Model                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 5.1 | Design review: bot container architecture, audio capture path, join/admit/leave lifecycle (study Vexa + screenappai/meeting-bot first) | **Fable**                          |
| 5.2 | Bot container: Playwright + Chromium + Xvfb + PulseAudio virtual sink; join a Meet URL as named guest                                  | **Opus**                           |
| 5.3 | Audio capture: PulseAudio monitor → ffmpeg → rolling upload to R2                                                                      | **Opus**                           |
| 5.4 | Meeting lifecycle: detect admission, detect meeting end, crash recovery, max-duration kill switch                                      | **Opus**                           |
| 5.5 | Bot orchestrator service: spawn/track/reap bot containers (Docker API), one per meeting                                                | **Opus**                           |
| 5.6 | Debugging pass on real Meets (Meet UI changes, admission edge cases)                                                                   | **Fable** (reserve for when stuck) |

### Phase 6 — Calendar integration + auto-join

| #   | Ticket                                                                                   | Model  |
| --- | ---------------------------------------------------------------------------------------- | ------ |
| 6.1 | Google OAuth per tenant (Calendar read scope), token refresh handling                    | Sonnet |
| 6.2 | Calendar watch webhooks + polling fallback; detect Meet links in events                  | Sonnet |
| 6.3 | Scheduler: enqueue bot spawn N minutes before meeting start; user opt-in/out per meeting | Sonnet |

### Phase 7 — Hardening + launch

| #   | Ticket                                                                                                                                                                                                      | Model     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 7.1 | Security review: tenant isolation, presigned URL scoping, bot container escape surface, secrets                                                                                                             | **Fable** |
| 7.2 | Rate limiting, request validation, audit log                                                                                                                                                                | Sonnet    |
| 7.3 | Observability: metrics endpoint, queue-depth alerts, uptime check                                                                                                                                           | Sonnet    |
| 7.4 | Landing page + docs site at `scribeflow.deepcoomer.dev`                                                                                                                                                     | Sonnet    |
| 7.5 | Load test: 10 concurrent 1-hour meetings through the pipeline                                                                                                                                               | **Opus**  |
| 7.6 | Seeded demo tenant: "View live demo" button (no signup) → dashboard pre-populated with ~10 processed sample meetings, transcripts, action items, analytics; seed script re-runs idempotently                | Sonnet    |
| 7.7 | Demo video: script + record 2-min walkthrough of the bot joining a real Meet → pipeline → dashboard; embed on landing page and README (recording is manual; ticket covers script, player embed, R2 hosting) | Sonnet    |
| 7.8 | Uptime insurance: UptimeRobot monitor on API + app; static fallback state in the Vercel-hosted frontend (demo video + architecture diagram + GitHub link) shown automatically when the API is unreachable   | Sonnet    |

### Phase 8 (stretch) — Zoom

Only after the Meet bot is stable. Zoom's web client allows guest joins, so the same
Playwright + PulseAudio approach ports over; ticket breakdown mirrors Phase 5.

## 4. Sequencing logic

Pipeline before bot: the bot's only output is an audio file, so the upload path
(Phases 1–4) lets you build and demo the entire intelligence product with manually
uploaded recordings while the bot — the flakiest component — is developed against a
stable pipeline.

## 5. Ticket count by model

≈ 28 Sonnet · 13 Opus · 5 Fable (plus two mostly-manual go-live tickets, 1.7/1.8) —
roughly 61/28/11%. Phase 4's move to Postgres (D42) also downgraded its tickets
from Opus to Sonnet. The remaining Fable tickets are all spec-writing (2.1, 2.6
design half, 5.1), the security review (7.1), and the stuck-bot escalation
reserve (5.6) — zero scheduled implementation (D41). See
[model-strategy.md](model-strategy.md).

Every architectural and product decision behind these tickets is logged with
reasoning and rejected alternatives in [decisions.md](decisions.md) — cite entries
as `D<n>`.
