# Claude Code Model Strategy

You're building this with Claude Code on a subscription, so the optimization target
is **usage budget and speed, not API dollars**: run every ticket on the cheapest
model that will one-shot it, and spend Fable only where a wrong design decision would
cost days to unwind. Fable is not needed for every ticket — most of this project is
well-trodden ground that Sonnet handles fine.

## The assignment rule

Ask two questions about a ticket:

1. **Is the design already decided?** (by these docs, or by convention)
2. **Is the implementation pattern common?** (CRUD, React components, Dockerfiles,
   OAuth flows — things with thousands of public examples)

Both yes → **Sonnet 5**. Design decided but implementation is genuinely tricky
(concurrency, exactly-once semantics, non-trivial algorithms, gnarly debugging),
or it's a mid-project code review → **Opus 4.8** (use fast mode for
iteration-heavy debugging). Design NOT decided → **Fable 5**, whose deliverable
is a **spec** (design doc + sharpened tickets), not code (D41). Mechanical edits
(renames, lint, config bumps, commit messages) → **Haiku 4.5** or just Sonnet.

## What each model owns in this project

### Sonnet 5 — the default workhorse (~55% of tickets)

Scaffolding, migrations, Fastify CRUD endpoints, auth flows, presigned-URL endpoint,
the entire React dashboard, transcript viewer, action-items UI, calendar webhook
integration, Dockerfiles/Compose, CI, SSE plumbing, sentiment batch worker, docs,
tests for all of the above. If you're unsure, start with Sonnet — a failed attempt
costs little, and you can restate the ticket to Opus with `/model`.

### Opus 4.8 — decided design, hard implementation (~33%)

- RabbitMQ topology, retry/DLQ machinery, idempotent worker framework (1.2, 1.3)
- The racing engine implementation: slicer, parallel transcriber with shared rate
  limiting, fan-in stitcher (2.2–2.4, 2.7)
- (Phase 4 analytics moved to Sonnet when it moved to Postgres, D42)
- LLM extraction worker with strict-JSON retry loops (3.1)
- The Meet bot container + orchestrator (5.2–5.5) — Playwright lifecycle code with
  many failure modes
- Load testing and the chaos-test suite
- Mid-project code reviews, e.g. the full pipeline review before Phase 3 (2.8) —
  a well-prompted Opus review catches the same class of issues (D41)

### Fable 5 — the spec-writer (~11%, D41)

Fable's deliverable is always a **document, never an implementation**: it turns a
phase's goals into detailed, decided tickets and design docs that Sonnet/Opus can
execute without judgment calls. The better the spec, the cheaper the model that
can build it — that's the whole economics of this file.

- 2.1 — spec the chunk/overlap/stitch algorithm and its edge cases
- 2.6 (design half) — spec the diarization–transcript merge and interruption
  semantics; Opus implements
- 5.1 — bot architecture spec after studying Vexa/meeting-bot
- 7.1 — security review (tenant isolation, presigned scoping, container surface).
  The one review kept on Fable: its value is finding what no spec anticipated,
  and it's a single session guarding the project's worst failure mode
- 5.6 — unscheduled escalation reserve: when Opus is stuck in a debugging loop on
  the Meet bot for more than a couple of sessions, switch up once rather than
  burning iterations

(0.6 ran on Fable before this rule was sharpened; 2.8 moved to Opus.)

## Workflow tips

- **Hand Fable's output to the cheaper models.** The Phase 2 pattern is explicit:
  Fable writes the stitch-algorithm design doc into `docs/`, then Opus implements
  against it, then Sonnet writes the tests. The docs in this repo exist precisely so
  the cheaper models have the context to work autonomously.
- **Escalate on the second failure, not the fifth.** If Sonnet botches a ticket
  twice, re-run once on Opus with the failure context; don't keep retrying downward.
- **Reviews beat rewrites.** A `/code-review` pass over a built subsystem is far
  cheaper than having a bigger model write it. Run routine reviews on Opus; only
  the final security review earns Fable (D41).
- **One ticket per session.** Small, well-scoped prompts referencing these docs
  ("implement ticket 2.3 per docs/architecture.md §racing engine") keep any model
  on-target and keep context small.
