# Decision Log

Every significant decision, its reasoning, and what was rejected. Cite as `D<n>`
from other docs, PRs, and commit messages. When a decision is reversed, don't
delete it — mark it `SUPERSEDED by D<n>` and add the new entry. This doc doubles as
interview prep: each entry is the answer to "why did you choose X?"

## Product & scope

**D1 — Keep the name ScribeFlow.**
Descriptive (scribe = what it does, flow = async pipeline), clean as a subdomain,
directory already named for it. _Rejected:_ Debrief, EchoNote, Minutable — taken as
products or less descriptive.

**D2 — Google Meet first, Zoom later (Phase 8).**
One platform's UI quirks is enough risk for v1; Meet is what Deep's target users
(and interviewers) use most. The bot's join-flow is behind a `platform` strategy
interface so Zoom is additive, not a rewrite. _Rejected:_ launching multi-platform —
triples the flakiest surface for zero portfolio gain.

**D3 — Build the pipeline before the bot.**
The bot's only output is an audio file, so the upload path lets the entire
intelligence product be built and demoed with manually uploaded recordings while
the flakiest component (the bot) is developed against a stable pipeline. _Rejected:_
bot-first — blocks everything downstream on the least reliable piece.

**D4 — Add the agent layer (RAG chat, follow-up drafts, nudges) to v1.**
Deep's stated goal is "an AI that makes users more productive," and the resume
story is stronger as _agent + pipeline_ than analytics alone. Pure-agent project
ideas were rejected as thin (mostly prompt glue, crowded category, weak evidence of
senior backend skill); ScribeFlow keeps the systems depth and adds the agent on top.

**D5 — Human-in-the-loop for all outbound agent actions.**
The follow-up agent drafts; a person approves before anything sends. An agent that
auto-emails a wrong summary to a client destroys trust once and forever. _Rejected:_
auto-send with an undo window — undo doesn't exist for email.

**D6 — Position on the resume as full-stack engineer (3 YoE) demonstrating
senior-scope work, not "senior developer."**
Claiming senior at 3 YoE invites harsh grading at screens; letting the system
design speak converts better. Demo-ability tickets (7.6–7.8) exist because the
project's career value depends on a recruiter reaching a working demo in under a
minute and the link never being dead.

## Pipeline architecture

**D7 — API never touches media bytes; clients upload straight to R2 via presigned URLs.**
A 200 MB upload through a 12 GB shared VM's Node process would block the event loop
and blow the RAM budget; presigned URLs make upload bandwidth Cloudflare's problem
and keep the API stateless. _Rejected:_ multipart upload through the API — the
classic junior mistake this project exists to avoid.

**D8 — RabbitMQ for the queue.**
Needs: competing consumers across languages (Node publishes, Python consumes),
per-queue prefetch tuning (CPU-bound diarizer=1 vs IO-bound transcriber=4),
dead-letter + TTL retry ladders, and durable delivery. RabbitMQ gives all four
out-of-the-box and is a named skill in job listings. _Rejected:_ Kafka —
operationally heavy for 12 GB, and this is job-queue semantics, not stream
replay; BullMQ/Redis — ties workers to Node or awkward polyglot clients, weaker
DLQ story; Postgres SKIP LOCKED — viable and simpler, but forfeits the fan-out
routing and the portfolio signal of real broker design.

**D9 — Polyglot split: Node/Fastify API, Python workers.**
The ML ecosystem (pyannote, ffmpeg bindings, sentence-transformers) is
Python-native; the web ecosystem (Fastify, Zod, SSE, Playwright) is Node-native.
Queue messages with pydantic/Zod-validated schemas are the contract between them.
_Rejected:_ all-Python (weaker API/frontend tooling) and all-Node (no pyannote,
would force diarization to a paid API and break D22's $0 constraint).

**D10 — Racing engine: 300 s chunks with 10 s overlap.**
5 min balances parallelism (13 chunks/hour meeting — one Groq burst under the
20 req/min cap, D24) against per-chunk overhead and edge artifacts; Whisper
degrades at chunk edges, so 10 s overlap ensures no word is lost at a boundary.
_Rejected:_ 1-min chunks (60 requests/meeting hammers rate limits, more edges to
stitch), no overlap (guaranteed word loss mid-boundary).

**D11 — Deterministic stitch: cut at the overlap midpoint, prefer the chunk where a
straddling segment sits furthest from that chunk's edge, ties broken by chunk index.**
Determinism means retries and RabbitMQ redeliveries always reproduce the same
transcript — idempotency for free. _Rejected:_ LLM-based merge (non-deterministic,
costs quota, unverifiable) and longest-common-subsequence token matching (complex,
and Whisper's edge hallucinations defeat it).

**D12 — Diarization runs once on the full file, never chunked.**
pyannote clusters speaker embeddings globally; chunked diarization lets "Speaker A"
in chunk 1 become "Speaker B" in chunk 4 with no way to reconcile labels. It runs
in parallel with the racing branch so it doesn't extend wall-clock time.
_Rejected:_ chunked diarization + cross-chunk re-clustering — a research project,
not a feature.

**D13 — Speaker↔segment merge by maximum temporal overlap; >30 % overlap with two
turns flags an interruption.**
Simple, deterministic, and the double-overlap case is repurposed as the
interruption metric the analytics layer wants anyway. _Rejected:_ word-level
speaker assignment — pyannote turn boundaries aren't word-accurate, so it fakes
precision.

**D14 — Fan-in via one atomic Postgres statement
(`UPDATE … SET chunks_done = chunks_done + 1 … RETURNING`).**
The worker that observes `chunks_done = total_chunks` triggers the stitcher.
Single-statement atomicity means no distributed lock, no Redis, no coordinator
service. _Rejected:_ Redis counters (new infra for one integer), RabbitMQ
message-count tricks (broker state is not application state).

**D15 — Deterministic job IDs (`{meetingId}:{stage}:{chunkIdx}`) + upsert-only writes.**
At-least-once delivery is a queue fact of life; idempotent consumers make
redelivery harmless instead of a bug class. This is an invariant in CLAUDE.md, not
a convention.

**D16 — Timestamps converted to absolute meeting time at the worker boundary.**
Chunk-relative time leaking downstream is the subtlest bug class in this system;
converting once at write time (shift by `offset_s`) means nothing downstream ever
reasons about offsets.

## Data layer

**D17 — Two databases: Postgres for state, ClickHouse for analytics.**
Postgres owns transactional truth (tenants, meetings, jobs, action items — needs
updates, FKs, row locks). ClickHouse owns append-only utterances where dashboard
queries aggregate millions of rows; its MergeTree + materialized views keep
talk-time/sentiment queries interactive on a shared VM where Postgres GROUP BYs
would crawl. _Rejected:_ Postgres-only (analytics queries degrade the OLTP path
and vice versa on 12 GB), ClickHouse-only (no transactional updates), TimescaleDB
(respectable middle ground, but weaker compression/MV story and less impressive
portfolio signal).

**D18 — ClickHouse ordering key starts with `tenant_id`; dashboards read from
materialized views, drill-downs from the base table.**
Tenant-first ordering makes tenant scoping nearly free at query time; MVs
pre-aggregate per (tenant, speaker, day) so the dashboard never scans raw
utterances.

**D19 — pgvector + local sentence-transformers for the RAG layer.**
Embeddings on CPU are fast enough for async indexing, cost $0, and pgvector means
no new database — retrieval joins directly against tenant-scoped Postgres rows.
*Rejected:* Pinecone/Qdrant Cloud free tiers (another external dependency and
tenant-isolation surface), OpenAI embeddings (violates $0).

**D20 — Multi-tenancy enforced structurally: `tenantId` is a required parameter of
every repository function, R2 keys are tenant-prefixed, ClickHouse goes through a
predicate-injecting query builder.**
Scoping enforced by function signature turns "forgot the WHERE tenant_id" from a
data leak into a compile error. _Rejected:_ Postgres row-level security alone
(silent when misconfigured, doesn't cover R2 or ClickHouse) — may be added later as
defense-in-depth, not as the primary mechanism.

## External services & $0 constraint

**D21 — Groq free tier for both Whisper transcription and LLM extraction.**
Deep already holds the key; one vendor covers both needs; `whisper-large-v3-turbo`
free limits (~2 h audio per clock-hour, 2 000 req/day) exceed portfolio scale.
_Rejected:_ OpenAI (paid), self-hosted Whisper as primary (ties throughput to a
2-OCPU ARM CPU).

**D22 — Every dependency must have a $0 tier AND a documented fallback; build the
`TRANSCRIBE_BACKEND=groq|local` switch in Phase 1.**
Free tiers are rented ground — Oracle halved its free tier in June 2026 mid-planning.
The switch costs ~50 lines and converts "Groq changed their terms" from an outage
into a config change (fallback: whisper.cpp on Deep's Apple Silicon Mac). Full
fallback ladder in [infrastructure.md](infrastructure.md).

**D23 — pyannote self-hosted on CPU for diarization.**
The only free diarization of acceptable quality; ~real-time CPU speed is fine
because the pipeline is async and diarization runs parallel to transcription (D12).
_Rejected:_ paid diarization APIs (AssemblyAI, Deepgram — violate $0), skipping
diarization (speaker attribution is the product).

**D24 — Shared token-bucket rate limiter (Postgres advisory lock) in front of Groq.**
20 req/min is an org-wide limit; without a shared limiter, two concurrent meetings'
chunk bursts trigger 429 storms and retry amplification. _Rejected:_ per-worker
limiters (don't compose org-wide), Redis limiter (new infra; Postgres is already
there).

## Hosting & networking

**D25 — Single Oracle Always Free ARM VM running everything server-side via one
Docker Compose file.**
$0, and one box removes cross-network latency and config sprawl. Every service is
stateless except the DBs, so scale-out later = move containers to another host
pointed at the same RabbitMQ — the queue-centric design (D8) is what makes that a
config change. Known constraint: 12 GB RAM budget caps concurrent bot containers
at one (D31). _Rejected:_ Fly.io/Railway/Render (free tiers gone or too small for
ClickHouse+RabbitMQ), k8s (absurd overhead at this scale; Compose→k8s is a
mechanical migration if ever needed), serverless (ffmpeg/pyannote runtimes and
long-running jobs fight FaaS limits).

**D26 — Cloudflare R2 for object storage.**
10 GB free and **zero egress fees** — egress is the hidden killer for audio
workloads (every chunk download would be billed on S3). S3-compatible API keeps
vendor lock-in nil. Lifecycle rule deletes raw audio 30 days post-transcript to
stay under 10 GB. _Rejected:_ AWS S3 (egress), Backblaze B2 (kept as fallback,
weaker presigned-URL + CORS ergonomics).

**D27 — Cloudflare Tunnel instead of open inbound ports.** _SUPERSEDED by D39._
Outbound-only connection from the VM: no firewall rules, no cert management, VM IP
hidden, and the identical setup works if the "server" is ever Deep's Mac at home
(D22 fallback). _Rejected:_ Caddy on open 443 (fine, but tunnel strictly dominates
for this threat model and portability). _Why superseded:_ the tunnel's "strictly
dominates" argument assumed we were already inside Cloudflare for Pages + DNS;
once the frontend moved to Vercel (D40) the tunnel became the only reason to keep
a second vendor.

**D28 — Flat subdomains: `scribeflow.deepcoomer.dev` + `scribeflow-api.deepcoomer.dev`.**
Cloudflare Universal SSL covers only one label deep (`*.deepcoomer.dev`);
`api.scribeflow.deepcoomer.dev` would need a paid cert. _Rejected:_ nested
subdomains (paid ACM), separate domain (Deep already owns deepcoomer.dev; resume
link should carry his name). _Note (post-D39/D40):_ the original constraint no
longer applies — Vercel and Let's Encrypt both handle nested subdomains fine —
but the flat names stay: they're shorter and already wired through the docs.

**D29 — SSE for real-time dashboard updates, not WebSockets.**
Updates are one-directional (server→client) and infrequent; SSE auto-reconnects
natively, is plain HTTP through any proxy (Caddy included), and needs no extra
infrastructure. _Rejected:_ WebSockets (bidirectional capability nothing uses,
more moving parts), polling (latency + wasted queries).

**D39 — Expose the API directly: Caddy on the VM's port 443 with automatic
Let's Encrypt TLS; no tunnel. (Supersedes D27.)**
With the frontend on Vercel (D40), Cloudflare would have been kept solely for the
tunnel — one less vendor beats a hidden IP for this project. Caddy renews certs
itself; DNS is a plain A record `scribeflow-api.deepcoomer.dev → VM IP` at the
existing registrar. Accepted trade-offs: the VM IP is public, so the firewall
must stay tight (443 + SSH only, in **both** the Oracle security list and ufw —
Oracle has two firewall layers and missing the security list is the classic
gotcha), and the D22 "host from the Mac at home" fallback gets harder (would
reinstate a tunnel or use Tailscale Funnel if ever needed). R2 stays (D26) — it's
a Cloudflare account product, needs no DNS involvement.

**D40 — Host the frontend on Vercel at `scribeflow.deepcoomer.dev`.
(Supersedes the hosting half of D35; the React + Vite static SPA choice stands.)**
Deep's preference; equally $0 (Hobby tier, fine for non-commercial portfolio use);
plain CNAME at the existing registrar with no nameserver migration; Vercel manages
TLS. Root directory `web/`, framework preset Vite. _Rejected:_ Cloudflare Pages —
functionally equivalent, but choosing it forced DNS onto Cloudflare, which was
the entire justification for the tunnel (D27).

## Meet bot

**D30 — Browser-automation bot (Playwright + Chromium + Xvfb + PulseAudio in
Docker), joining as a visible named participant.**
Google exposes no free recording API for Meet (native recording requires paid
Workspace and lands in the host's Drive); every commercial notetaker uses the
browser-bot approach. Non-headless Chromium on Xvfb because headless is
fingerprinted/blocked by Meet. Visibility is also the consent mechanism (D33).
_Rejected:_ Meet Media API / Workspace APIs (paid tier, host-only), hidden capture
(unethical, and D33 forbids it).

**D31 — One ephemeral container per meeting; orchestrator semaphore caps
concurrency at 1.**
Per-meeting containers give crash isolation and clean reaping; Chromium+Xvfb costs
~2 GB, and the 12 GB budget (D25) affords one alongside the pipeline. Excess spawn
requests queue with a TTL so a bot never joins a meeting that already ended.
_Rejected:_ multi-meeting shared browser (one crash kills all recordings; audio
sink routing across tabs is fragile).

**D32 — Bot records in 5-minute segments uploaded as the meeting runs, not one file
at the end.**
A crash loses ≤5 minutes instead of the whole meeting, and the racing engine (D10)
gets its chunks for free — bot recordings skip the slicer entirely. _Rejected:_
single-file recording (all-or-nothing loss profile).

**D33 — Consent is non-negotiable: bot always visibly named "ScribeFlow Notetaker";
host admission = consent; optional on-join chat announcement for two-party-consent
jurisdictions; no hidden mode will ever be built.**
Legal exposure aside, a notetaker product lives on trust. This is a CLAUDE.md
invariant.

**D34 — Study Vexa (Apache 2.0) and screenappai/meeting-bot before building ours,
but build our own.**
Their solutions to Meet's UI quirks save days; building it ourselves is still the
point — the bot is the portfolio flagship. _Rejected:_ depending on Vexa wholesale
(then the hardest part of the project isn't Deep's work).

## Frontend & demo

**D35 — React + Vite static SPA on Cloudflare Pages; no SSR.** _Hosting half
SUPERSEDED by D40 (Vercel); the static-SPA/no-SSR half stands._
The dashboard is auth-gated and real-time — SSR buys nothing; a static bundle
deploys free with zero server load on the VM. _Rejected:_ Next.js SSR (needs a
Node server or Workers adapter; solves SEO problems a dashboard doesn't have —
the landing page is static anyway).

**D36 — Seeded no-signup demo tenant + 2-min bot video + static fallback page
(tickets 7.6–7.8).**
A recruiter gives the link ~60 seconds: they will not sign up, upload audio, or
wait for a pipeline; and nobody can experience the bot as a drive-by visitor. The
static fallback (auto-served when the API is down) exists because Oracle reclaims
free instances and a dead resume link is worse than no link.

## Development process

**D37 — Ticket-per-session development with per-ticket Claude Code model
assignment: Sonnet default, Opus for decided-design/hard-implementation, Fable only
for undecided design and critical reviews.** _Fable's role narrowed by D41._
Optimizes subscription usage and speed; most tickets are well-trodden ground. Full
rationale in [model-strategy.md](model-strategy.md). Escalation rule: second
failure, not fifth.

**D41 — Fable is the spec-writer, not an implementer or routine reviewer.
(Narrows D37.)**
Observation after Phase 0: Fable's actual value-add was specs — design docs, the
decision log, sharpened tickets — which is exactly what lets Sonnet execute most
tickets unaided. So: Fable writes phase-start specs; mid-project code reviews
(e.g. 2.8) run on Opus, which catches the same issue class when well-prompted.
Two carve-outs stay on Fable: the final security review (7.1), because a
review's value is finding what no spec anticipated and tenant leaks are the
project's worst failure mode; and the escalation valve (5.6) when a cheaper
model loops on one bug across sessions. _Rejected:_ scheduled Fable
implementation tickets (spec quality, not executor size, is the lever).

**D38 — Design docs are authoritative and updated in the same PR when reality
diverges; decisions land here with a D-number.**
The docs are how cheaper models (and future Deep) get context without re-deriving
it, and this log is the interview-prep artifact: every "why X?" question an
interviewer can ask should have a D-entry answer.
