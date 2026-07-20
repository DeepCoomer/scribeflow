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

**D46 — Chunk count `n = max(1, ceil((D − 10) / 290))`; final chunk runs to
end-of-file; a would-be final chunk under 30 s is absorbed into its predecessor.**
The formula guarantees full coverage with the D10 overlap; running the last
chunk open-ended (`-ss` only) avoids off-by-one truncation at the file tail; the
30 s absorption floor avoids paying a whole Groq request + stitch boundary for
seconds of audio (the absorbed chunk tops out at 330 s — nowhere near the
100 MB/request cap as FLAC). `D ≤ 300 s` degenerates to one chunk with
`offset_s = 0`, which is exactly the Phase 1 single-shot shape (D45).
_Rejected:_ fixed `n = ceil(D/290)` (emits a near-empty final chunk that is
mostly overlap), padding the tail with silence (invites Whisper hallucinations,
D48).

**D47 — Chunks are always re-encoded to 16 kHz mono FLAC; never stream copy.
The slicer uploads chunk objects to R2 and jobs reference the chunk key.**
Decode→resample→encode gives sample-exact cut points, so `offset_s` is exact —
stream copy cuts at packet granularity and can drift from the requested `-ss`,
which is precisely the offset-error class D16 exists to kill. Re-encoding also
normalizes every source container into one uniform Groq input. Chunk objects
live under `tenant/{t}/meeting/{m}/chunks/{idx}.flac` (covered by the 30-day
lifecycle rule — no active cleanup). This supersedes the earlier
"stream copy when the format allows it" wording in architecture.md.
_Rejected:_ stream copy (offset drift), byte-range downloads of the original
(ranges of compressed containers aren't independently decodable).

**D48 — Hallucination filter in the chunk transcriber: drop a segment when
`no_speech_prob > 0.6 ∧ avg_logprob < −1.0`, or when `compression_ratio > 2.4`;
an empty chunk is a success.**
These are Whisper's own published heuristics for non-speech and repetition
hallucination; filtering before storage means the stitcher never sees phantom
edge segments. A chunk with zero surviving segments still completes fan-in, and
an all-silent meeting finalizes `done` with an empty transcript (`duration_s`
from ffprobe, not segment ends). Requires `parse_verbose_json` to carry the
three confidence fields it currently discards — an additive internal-model
change, not a queue-contract change. _Rejected:_ filtering at the stitcher
(every consumer of `transcript_segments` before stitch would see hallucinations)
and energy-based VAD pre-filtering (a second inference pass to save requests we
don't need to save).

**D49 — Chunk retry exhaustion: terminal `exhausted` job state + fan-in still
increments; the stitcher derives gap intervals into `transcript_gaps`.**
The exhausted-hook's conditional transition
(`SET status = 'exhausted' WHERE … status <> 'exhausted'`) is the exactly-once
guard for its `chunks_done` increment, so fan-in always closes and a failed
chunk can never wedge a meeting in `transcribing`. The stitcher — not the
worker — computes uncovered intervals (`[0, D]` minus succeeded chunks'
coverage) into a `transcript_gaps` table, and owns the terminal status: any
gap → `partial`, zero successes → `failed`, else `done`. _Rejected:_ sentinel
gap rows inside `transcript_segments` (fake segments poison every downstream
consumer — search, embeddings, extraction) and having the exhausted-hook mark
the meeting `partial` directly (races the stitcher for the status; two writers
of a terminal state is how meetings end up `partial` after a successful
stitch).

**D50 — Chunk completion is one transaction (segments + job→done + counter),
and the `claim_job` skip path re-checks fan-in.**
Bundling `replace_segments`, the conditional `jobs → 'done'` transition, and
the counter increment into a single commit makes the increment exactly-once
under redelivery (refines D14, which specified only the atomic statement). The
crash window _after_ commit but _before_ publishing `meeting.stitch` is closed
on the redelivery path: a worker that finds its job already done re-reads the
counters and republishes `meeting.stitch` if fan-in is closed while the
meeting still says `transcribing` (harmless — the stitcher claims its own
job). Diarization exhaustion sets `diarization_done = true` with the error
recorded, so the stitch trigger is never blocked forever; the merge proceeds
speakerless and forces `partial`. _Rejected:_ a periodic sweeper that finds
wedged meetings (a second code path doing the same decision on a timer — the
redelivery we already get for free is the sweep).

**D51 — `JobContext` gains a generic `publish(routing_key, message)` for the
pipeline exchange, alongside the existing `publish_event`.**
Tickets 2.2–2.5 all need to emit downstream jobs (chunk.transcribe,
meeting.diarize, meeting.stitch), not just status events — one framework
primitive (persistent delivery, `delivery_mode=2`) serves all of them instead
of each worker hand-rolling its own `basic_publish` call. `publish_event`
stays separate and non-persistent, since SSE forwarding was already correctly
scoped as ephemeral. _Rejected:_ a bespoke publish helper per worker
(duplicates broker mechanics the framework already owns for events).

**D52 — pyannote.audio/torch ship as an optional `diarize` uv
dependency-group, not a base dependency; `PyannoteBackend` imports it lazily.**
Torch is a multi-GB transitive install; making it required would slow down
`uv sync` and CI for every worker, not just the diarizer, and this project
already treats "no live heavy-model calls in CI" as the norm (mirrors
`GroqBackend`'s lazy `groq` import). The diarizer's runtime image installs
the extra explicitly at build time (`workers/Dockerfile`); default `uv sync`
never touches it. _Rejected:_ a required dependency (bloats every dev/CI
environment for code most sessions never run) and a second Dockerfile (more
to maintain for what's really one `--extra` flag).

**D53 — Live topology rebinds must explicitly unbind the old routing key,
not just stop asserting it.**
RabbitMQ never drops a binding just because the code stopped declaring it —
a broker that already ran Phase 1 (this one had) keeps `q.transcriber`
bound to `meeting.uploaded` forever unless something explicitly unbinds it,
so after the D45 rebind that broker would deliver every upload to both
`q.slicer` and `q.transcriber`, and the chunk transcriber would receive and
park malformed messages it was never meant to see. Both topology mirrors
(`topology.py`'s `declare_topology`, `queue.ts`'s `assertTopology`) now issue
an explicit unbind of `q.transcriber`'s old `meeting.uploaded` binding on
every boot — a no-op once a broker no longer has it, so it's safe to leave
in permanently rather than removing it after one deploy. _Rejected:_ a
manual `rabbitmqctl` runbook step (easy to forget, and defeats the point of
"topology is code, both sides assert it on connect").

**D54 — Stitch side-assignment and cross-cut dedup only trim at a cut point
when both neighboring chunks are present; "present" means the chunk's
transcribe job status is `done`, not "has segment rows."**
The cut-point rule in D11/D49 was originally specified purely from
chunk_idx arithmetic, with no account for a missing neighbor. Applied
blindly next to an exhausted chunk, it silently discards a few good seconds
of the surviving neighbor's transcript for no reason — there's nothing on
the failed side to deduplicate against. Defining "present" as job status
`done` (rather than presence of rows) matters because a chunk that
succeeded but yielded zero segments after the D48 hallucination filter must
still count as present, so its neighbors keep trimming normally; only a
genuinely `exhausted` chunk disables trimming on that side. Gap computation
(D49) is unaffected — it already worked off this same per-chunk success set
independently of segment-level dedup. _Rejected:_ always trimming regardless
of neighbor status (loses good data next to any failure) and treating
"zero rows" as "chunk failed" (would gap-mark genuinely silent-but-successful
audio, contradicting D48).

**D58 — The terminal-status-ownership rule (D49: the stitcher owns
done/partial/failed) extends to every exhausted-hook that sits outside the
fan-in/stitch machinery, not just the chunk transcriber's.**
Found during the 2.8 pipeline review: the slicer's exhausted-hook
unconditionally set the meeting to `failed` on giving up, reasoning that
"nothing has been sliced yet" — true only when the very first chunk in the
per-chunk loop fails. Every retry of the slicer job re-runs that loop from
scratch, and each attempt's successfully-sliced chunks publish real,
idempotent `chunk.transcribe` jobs (D15) before that attempt itself fails
partway through. Under a flaky-but-not-fully-broken failure (a transient
R2/ffmpeg error that doesn't hit the same chunk index on every attempt),
those chunks can independently complete the pipeline — and the stitcher can
reach a real `done`/`partial` — before the slicer job's own retries exhaust.
Overwriting that with `failed` is exactly the two-writers-of-a-terminal-state
hazard D49 named for the chunk exhausted-hook, just not noticed at the
slicer callsite when 2.2 shipped. Fix: `db.fail_meeting_if_not_terminal`
(`WHERE status NOT IN (done, partial, failed)`, mirroring the exactly-once
`RETURNING`-gated pattern used throughout `db.py`) replaces the slicer
exhausted-hook's direct `set_meeting_status` call; a `False` return (already
terminal) also skips the `failed` SSE event, so a live dashboard client
never sees a status that contradicts what already shipped. The same review
found the diarizer's redelivery-recheck path (a duplicate `meeting.diarize`
arriving after the meeting was already stitched) republishing
`meeting.stitch` unconditionally — harmless (D50: the stitcher's own
`claim_job` dedups it) but pointless queue chatter the transcriber's
analogous path already guards against; `_maybe_trigger_stitch` gained a
`require_transcribing` flag used only on that one call site, matching
transcriber.py's existing pattern. Also fixed in the same pass (invariant 2,
not a new decision): the 2.6 speaker-rename endpoint accepted a
caller-supplied `userId` without checking it belonged to the caller's own
tenant — `findUserById(tenantId, userId)` now gates it, same as every other
tenant-scoped write. _Rejected:_ leaving the slicer's `set_meeting_status`
call unconditional but tightening only the exhausted-hook's own retry
behavior (doesn't address that OTHER attempts' side effects, not this
attempt's, are what create the race — the guard belongs at the write, not
the retry).

**D55 — The speaker merge runs inside the stitcher; assignment aggregates
overlap per label, with NULL speaker on zero overlap.**
The merge's precondition — both branches terminal — is exactly the stitch
trigger condition, so a separate merge worker/message would add a queue hop
and a second crash window for zero parallelism gain. The stitcher assigns
speakers to the kept segments and commits them in the same finalize
transaction as the deletes, gaps, and terminal status: crash-safe, and pure
recomputation keeps stitch redelivery idempotent (extends D11's determinism
argument). Sharpenings of D13: overlap is **summed per label across turns**
(pyannote splits continuous speech into adjacent turns; single-turn
comparison undercounts the true speaker), ties go to the lexicographically
smallest label (determinism only), and zero overlap leaves `speaker` NULL —
no nearest-turn fallback, no minimum-overlap threshold. A visible "Unknown"
beats a confidently wrong name, and thresholds manufacture Unknowns from
turn boundaries that are merely sloppy. _Rejected:_ a dedicated merge stage
(above), nearest-turn fallback (fabricates attribution), minimum-overlap
threshold (creates false Unknowns).

**D56 — Segments store the raw diarization label; human names live in
`meeting_speakers`; calendar attendees are rename candidates, never
auto-assignments.**
`transcript_segments.speaker` keeps `SPEAKER_NN` as a stable key. A new
`meeting_speakers` table (`UNIQUE (meeting_id, speaker_label)`) maps label →
`display_name` with optional `user_id` and a provenance `source`
(`default|user|calendar|voiceprint`). The stitcher seeds defaults
("Speaker N", numbered by first turn start — first voice heard is
Speaker 1) via `ON CONFLICT DO NOTHING`, so re-stitching never clobbers a
user's rename, and renames are one-row updates instead of mass segment
sweeps. Phase 6's calendar roster only **feeds the rename UI's candidate
list** — an attendee list says who was present, not which voice is which,
so the count-matching auto-assignment sketched earlier in architecture.md
is explicitly rejected; per-tenant voice-print auto-matching stays the
documented stretch. _Rejected:_ denormalizing display names into segments
(rename becomes a mass update and a re-stitch clobbers it), auto-assigning
names by matching voice count to attendee count (guaranteed misattribution
with no human in the loop).

**D57 — Interruption detection is specified with the merge but materialized
only in Phase 4.1; `speaker_turns` is retained after the merge.**
The D13 rule sharpened: ≥2 distinct labels each overlapping >30 % of a
segment's duration flags an interruption (the interrupter is the
non-assigned label). It ships as a pure function in the merge module, but no
flag column lands on `transcript_segments` in v1 — nothing in the v1
product reads it (the same no-reader reasoning that deferred ClickHouse,
D42); Phase 4.1 computes it into `utterance_metrics` from the retained
`speaker_turns`. Retention also keeps re-stitching idempotent — the merge's
input must survive the merge. _Rejected:_ an `is_interruption` /
`interrupted_by` column now (an analytics column with no reader), deleting
`speaker_turns` post-merge (destroys the re-stitch input and 4.1's source
data).

## Intelligence layer

**D59 — Extraction worker (3.1): one job per meeting, triggered by the
stitcher on `done`/`partial` (never `failed`); strict JSON via a
retry-on-invalid loop inside the handler, not the queue's retry ladder.**
`meeting.stitch` gains a sibling `meeting.extract` message (job key
`{meetingId}:extract:0`, own `q.extractor` queue, D24-style shared rate
limiter under its own `groq_llm` bucket since Groq's free-tier limits are
per-model). The stitcher publishes it right after `finalize_stitch` commits,
guarded by `status != "failed"` — a `partial` transcript still has real
content worth summarizing, a `failed` one (zero surviving chunks) has
nothing to extract. The same crash-window argument as D50 applies to the
publish itself: the stitcher's post-claim-skip redelivery path re-checks
`job_exists(extract_job_key)` and republishes if it's missing, mirroring the
transcriber's analogous "republish meeting.stitch if fan-in closed but not
yet stitched" check — checking existence (not republishing unconditionally)
stops a duplicate stitch delivery arriving long after extraction already ran
from re-triggering it every time. A malformed/schema-invalid Groq JSON
response gets re-prompted in-line with the parse error (up to 3 total
attempts) before the handler raises and falls through to the standard D43
retry ladder — a prompt nudge is worth trying immediately, but a call that's
still broken after that is more likely a transient Groq issue than a fixable
prompt problem. An empty transcript (D48's "empty is a success" precedent)
skips the LLM entirely and writes a trivial summary. The transcript sent to
the model is capped at ~60k characters, eliding the middle and keeping
head+tail (summaries/decisions concentrate at a meeting's start and end far
more than its middle) — a documented v1 limitation, not full map-reduce
chunking. `source_ts_s` (the model's approximate mm:ss guess) links an
action item/decision to its nearest transcript segment only within a 60 s
tolerance and has no FK (see D60) — advisory, not authoritative. _Rejected:_
Opus for this ticket despite the model-strategy table calling it out as
"decided design, hard implementation" — run as Sonnet by explicit user
request across all of Phase 3, same deviation pattern as 2.6/2.7/2.8 (see
D41 note in plan.md); a separate merge-worker/queue hop for extraction
(adds a crash window for no benefit, same reasoning D55 used for the
speaker merge); failing the whole pipeline's terminal status on extraction
failure (extraction is an enhancement — a `done`/`partial` transcript is
already correct and complete without it).

**D60 — `meeting_summaries` is upserted by `meeting_id`; `action_items`
gains `owner_name` (free text) alongside `owner_user_id` (real assignment);
`source_segment_id` stays a plain uuid with no FK.**
Unlike `transcript_segments`/`action_items` (delete-and-reinsert-by-meeting,
D15), a summary has no natural per-row identity to replace — `meeting_id` is
already the unique key, so `INSERT ... ON CONFLICT (meeting_id) DO UPDATE`
is the idempotent shape for a redelivered `meeting.extract` job.
`action_items.owner_name` is what the LLM read off the transcript (usually a
speaker name) — never auto-resolved to a `users` row, the same "candidate,
not assignment" caution D56 applied to calendar attendees; `owner_user_id`
is set only by a human via the 3.3 UI's explicit assign action.
`source_segment_id` deliberately has no FK: a re-stitch deletes and
reinserts `transcript_segments` with fresh ids (D11/D49), so an FK (even
`ON DELETE SET NULL`) would silently orphan every existing action item's
transcript link on the next re-stitch. A plain uuid means a stale link just
404s in the UI instead of corrupting data. _Rejected:_ auto-matching
`owner_name` to a `users` row by name equality (guaranteed misattribution
the moment two people share a first name, same reasoning as D56's rejected
voice-count auto-match).

**D61 — Per-utterance sentiment (3.2) is a second batched call inside the
same extractor job/queue, not a separate worker or queue.**
architecture.md's data flow already describes "Intelligence (extractor):
LLM pass for action items / decisions / summary; sentiment pass per
utterance" as one step, not two — splitting it into a second queue hop
would buy nothing (both passes need the same finalized transcript, run
after the same trigger, and share the same rate-limit bucket) while adding
another crash window and job-ledger key to reason about. Segments are sent
to Groq in batches of 40 with a JSON array of `{segment_id, text}` and
scored `{segment_id, label, score}`; a batch's own retry-on-invalid loop
(same as D59) applies independently, and the per-segment `UPDATE` is
idempotent (unlike `action_items`/`meeting_summaries`, there's nothing to
replace-or-upsert — writing the same label/score twice is a no-op).
`transcript_segments` gains `sentiment_label`/`sentiment_score` columns,
null until this pass runs — Phase 4.1's `utterance_metrics` aggregation
reads them once that ticket lands. _Rejected:_ a dedicated `meeting.sentiment`
message/queue (extra crash window, no independent trigger condition to
justify it).

**D62 — Summary email (3.4) is approval-gated and sent only to the
requesting user, via Resend or a 503 if unconfigured.**
CLAUDE.md's project description states the summary/action items are
"delivered via dashboard + approval-gated email" — so `POST
/meetings/:id/summary-email` only ever fires from an explicit user click,
never automatically when extraction finishes (mirrors the 3.7 follow-up
agent's human-in-the-loop rule, invariant 7, applied one ticket early since
this is the same kind of send). Resend's HTTP API is a single POST, so
`lib/email.ts` calls `fetch` directly instead of adding the `resend` SDK
dependency — same "only what's needed" reasoning D26 applied to R2 (no S3
SDK abstraction beyond `@aws-sdk/client-s3` itself). Recipient is the
caller's own email, not a fan-out to attendees: there is no attendee
roster to send to before the Phase 6 calendar integration lands, and
guessing recipients from transcript speaker names would be exactly the kind
of misattribution D56 already rejected for renaming. Unset
`RESEND_API_KEY` disables the route (503), the same pattern R2 uses for the
upload endpoints — matches plan.md's "optional... or skip" framing for this
ticket. _Rejected:_ auto-send on extraction complete (violates the
approval-gate), emailing every tenant user (no roster to scope it to yet).

## Agent layer

**D63 — Embeddings (3.5) run as their own worker/queue in parallel with
extraction, writing directly to a `transcript_segments.embedding vector(384)`
column.**
Mirrors invariant 5's "diarization and transcription run in parallel and
merge independently" shape rather than folding embedding into the 3.1/3.2
extractor job: a slow or failed embed pass should never block or retry the
summary/action-items pass, and vice versa, so `meeting.embed` is a sibling
fan-out the stitcher publishes alongside `meeting.extract` (same trigger
condition — anything that isn't `failed`), not a third step inside it. The
vector lives as a column on `transcript_segments` itself (not a separate
`segment_embeddings` table) since it's a 1:1 per-segment enrichment, same
shape as 3.2's `sentiment_label`/`sentiment_score` columns — best-effort,
not part of the pipeline's terminal-status contract, null until the pass
runs. The model is `sentence-transformers/all-MiniLM-L6-v2` (D19's already-
decided choice), a CPU torch build behind its own `embed` extra (same
pattern as the diarizer's `diarize` extra) — the RAM line this adds
(0.75 GB) comes out of headroom, not the bot-container budget, so the
pipeline stays usable mid-recording. pgvector's HNSW index needs an
operator class (`vector_cosine_ops`) drizzle-kit's index builder can't
express, so it's hand-added in the migration SQL instead of declared in
schema.ts. Requires swapping the Postgres image from `postgres:16-alpine` to
`pgvector/pgvector:pg16` (same Postgres, extension pre-installed — nothing
else differs). _Rejected:_ embedding inside the 3.1/3.2 extractor job (couples
two independently-failable concerns), a separate `segment_embeddings` table
(no benefit over a column for a strict 1:1 relationship).

**D64 — The RAG chat's query-time embedding runs transformers.js/ONNX
in-process inside the Node API, not a second Python service or an RPC call
into the workers.**
The chat answer needs the user's query embedded into the _same_ vector space
3.5's documents live in, but the API and the Python workers are different
processes/languages with no existing sync call path between them (the queue
is fire-and-forget, wrong shape for a request/response chat turn). Standing
up a second HTTP service just to embed one string, or shelling out to
Python, both add an operational moving part for a single vector computation.
transformers.js ships `Xenova/all-MiniLM-L6-v2` — an ONNX export of the exact
weights `sentence-transformers/all-MiniLM-L6-v2` uses — so calling `pipeline
("feature-extraction", ...)` in Node lands in the same 384-dim cosine space
as the stored embeddings, no cross-language RPC needed. Retrieval itself is
raw SQL (`db.execute(sql\`...\`)`), not the query builder: pgvector's `<=>`cosine-distance operator and the`::vector`cast on a query embedding aren't
expressible through drizzle-orm's builder, same reasoning D63 gives for the
HNSW index. The endpoint is`POST /chat`with an SSE response, not an
EventSource`GET`the way the 1.6 status stream is (D44): a free-text query
doesn't fit safely/losslessly in a URL, and consuming`text/event-stream`only requires a`fetch()` `ReadableStream`reader, not the EventSource API
specifically. Citations ride as a separate structured SSE event (index,
meeting id, segment id, timestamp) rather than being parsed out of the LLM's
prose — the system prompt asks it to cite`[1]`/`[2]` inline, but the
frontend's clickable citation links come from the retrieval data ScribeFlow
already trusts, not from parsing free-form text. _Rejected:_ a Python
microservice or queue round-trip just for query embedding (new moving part
for one vector), OpenAI embeddings for the query side only (would still
need to match the document side's space, and violates $0 regardless).

**D65 — The follow-up email's default draft (3.7) is composed by a template
grouped by owner, not a second LLM call; only the actually-sent body is
persisted (`meeting_followups`, upserted by meeting).**
3.1 already extracted the summary and action items (with `owner_name`) —
everything the follow-up needs — so a second Groq call to re-derive the same
facts in prettier prose would spend rate-limit budget on a draft the human
edits before sending anyway (CLAUDE.md invariant 7: drafts, never
auto-sends). Grouping by owner is what actually differentiates this from
3.4's flat summary email — 3.4 answers "what happened," 3.7 answers "what's
on my plate" per person. `GET .../followup` returns the last-sent body if
one exists (so re-editing starts from what actually went out, not a wiped
slate or a silently-changed recompute) and only falls back to a fresh
default when nothing has ever been sent — same reasoning as 3.4/3.1's
"upsert by meeting_id, no per-row history" shape (`meeting_summaries`,
D60), since nobody reads a history of drafts, only the current one.
_Rejected:_ a second Groq call for the draft (spends quota re-deriving data
already extracted, for text a human overwrites anyway), storing every draft
revision (no reader for that history).

**D66 — The nudger (3.8) is a standalone sleep-loop script, not a queue
worker; it throttles to one email per owner per day via
`action_items.last_nudged_at`; the dashboard's overdue flag is independent
of whether any email ever sends.**
Every other worker in `framework.py` is message-driven (`Worker` consumes an
AMQP queue); the nudger's trigger is "a day has passed," which has no queue
message to bind to — wrapping a cron-shaped job in the AMQP consumer
machinery would be a worse fit than a plain `while True: run_once();
sleep(24h)` loop, so it gets neither a queue binding nor a `framework.Worker`
instance. `last_nudged_at` (compared against "start of today," not merely
"is it null") keeps a still-open, still-overdue item eligible for exactly
one digest per day rather than a single lifetime nudge or unlimited
re-sends — and it only advances for owners whose send actually succeeded, so
one bad email address doesn't silently suppress next-day retries for that
owner while every other owner's digest still goes out. Only items with a
real `owner_user_id` qualify (never an LLM-only `owner_name`) — same
"candidate, not assignment" caution D56/D59 already established, since
there's nobody real to email otherwise. The dashboard side of "notifies
owners" (plan.md) needs no nudger-written state at all: the action-items
page already has each item's due date, so flagging it overdue is a pure
client-side computation independent of whether Resend is configured or the
nudger has ever run — same "optional, or skip" gating as R2/email elsewhere,
but here the fallback isn't a 503, it's simply "the dashboard still works."
_Rejected:_ a `meeting.nudge` queue message (no producer/trigger event to
publish it from), nudging on every run regardless of `last_nudged_at`
(spams an owner once per deploy/restart instead of once per day).

## Data layer

**D17 — Two databases: Postgres for state, ClickHouse for analytics.**
_SUPERSEDED by D42 for v1; the design below is retained as the scale-out path._
Postgres owns transactional truth (tenants, meetings, jobs, action items — needs
updates, FKs, row locks). ClickHouse owns append-only utterances where dashboard
queries aggregate millions of rows; its MergeTree + materialized views keep
talk-time/sentiment queries interactive on a shared VM where Postgres GROUP BYs
would crawl. _Rejected:_ Postgres-only (analytics queries degrade the OLTP path
and vice versa on 12 GB), ClickHouse-only (no transactional updates), TimescaleDB
(respectable middle ground, but weaker compression/MV story and less impressive
portfolio signal).

**D18 — ClickHouse ordering key starts with `tenant_id`; dashboards read from
materialized views, drill-downs from the base table.** _Deferred with D42 —
applies if/when ClickHouse is introduced._
Tenant-first ordering makes tenant scoping nearly free at query time; MVs
pre-aggregate per (tenant, speaker, day) so the dashboard never scans raw
utterances.

**D19 — pgvector + local sentence-transformers for the RAG layer.**
Embeddings on CPU are fast enough for async indexing, cost $0, and pgvector means
no new database — retrieval joins directly against tenant-scoped Postgres rows.
*Rejected:* Pinecone/Qdrant Cloud free tiers (another external dependency and
tenant-isolation surface), OpenAI embeddings (violates $0).

**D20 — Multi-tenancy enforced structurally: `tenantId` is a required parameter of
every repository function, R2 keys are tenant-prefixed, and any future analytics
store (D42) goes through a predicate-injecting query builder.**
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

**D43 — Retry ladder via explicit tiered retry queues, not DLX nack chains.**
A failed message is republished by the worker framework to
`q.<worker>.retry.{30s|2m|10m}` (picked from the `x-attempts` header it carries)
and the original is acked; each retry queue has a message TTL and dead-letters
back to the work queue **by name through the default exchange**, so Phase 2 can
rebind routing keys without touching the retry path. After 4 total attempts the
message lands in `q.parking` with error-context headers, and a worker hook (e.g.
"mark the meeting failed") runs first. The work queue's own DLX also points at
the first retry tier as a safety net for bare nacks. _Rejected:_ pure
DLX/TTL-chain retries (can't pick the tier per attempt count — RabbitMQ's
x-death accounting is famously subtle) and delayed-message plugin (extra broker
plugin dependency for the same behavior).

**D44 — SSE streams authenticate via `?token=` query parameter.**
`EventSource` cannot set an `Authorization` header. The regular JWT rides as a
query parameter on `/meetings/:id/events` only, verified with the same secret,
and the stream is scoped by the token's tenant. Accepted trade-off: tokens can
appear in access logs — acceptable for v1 with 7-day tokens over TLS; ticket 7.2
(hardening) can move to short-lived stream tokens if needed. _Rejected:_
cookies (CSRF surface + cross-origin dashboard), `fetch`-based streaming client
(hand-rolling EventSource's reconnect for no security win in v1).

**D45 — Phase 1 binds `meeting.uploaded` to `q.transcriber` (single-shot);
the slicer takes over the binding in Phase 2.**
Ticket 1.4 is deliberately unchunked — the racing engine is Phase 2's hard
core, and a working upload→transcript path shouldn't wait for it. The
single-shot worker already writes chunk_idx 0 with an offset shift of 0, so
the Phase 2 migration is a rebind plus a slicer, not a rewrite. The topology
constants are code (api/src/queue/topology.ts ↔ workers/…/topology.py) and
both sides assert them, so the rebind is one PR touching both mirrors.

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
at the end.** _"Skip the slicer" half SUPERSEDED by D69._
A crash loses ≤5 minutes instead of the whole meeting, and the racing engine (D10)
gets its chunks for free — bot recordings skip the slicer entirely. _Rejected:_
single-file recording (all-or-nothing loss profile). _(5.1 review: the rolling
5-minute segments stay, but ffmpeg's `-f segment` output has no overlap, so the
segments cannot serve as racing-engine chunks — see D69 for the finalize path
that feeds bot recordings through the normal pipeline instead.)_

**D33 — Consent is non-negotiable: bot always visibly named "ScribeFlow Notetaker";
host admission = consent; optional on-join chat announcement for two-party-consent
jurisdictions; no hidden mode will ever be built.**
Legal exposure aside, a notetaker product lives on trust. This is a CLAUDE.md
invariant.

**D34 — Study Vexa (Apache 2.0) and screenappai/meeting-bot before building ours,
but build our own.**
Their solutions to Meet's UI quirks save days; building it ourselves is still the
point — the bot is the portfolio flagship. _Rejected:_ depending on Vexa wholesale
(then the hardest part of the project isn't Deep's work). _(Done in 5.1 —
findings distilled into meet-bot.md's "Prior art" section and D67–D72.)_

**D67 — Audio capture stays outside the page: PulseAudio null-sink monitor →
ffmpeg rolling segments; Chromium launched with
`ignoreDefaultArgs: ['--mute-audio']`.**
Both prior arts capture _inside_ the page on their Meet lane (screenapp:
`getDisplayMedia` + `MediaRecorder` shuttling base64 chunks over an exposed
function; Vexa: per-participant `<audio>`-element capture / an
`RTCPeerConnection` hook) — but they do so to serve needs ScribeFlow doesn't
have (video recording, live streaming to WhisperLive). In-page capture dies
with the page's JS state and couples the recording to Meet's DOM; the
PulseAudio monitor is one process boundary away from all of that and produces
a plain file ffmpeg already knows how to segment. The capture format is 16 kHz
mono Opus (~10 MB/h — half the infrastructure.md estimate), since the slicer
re-encodes to FLAC (D47) and pyannote resamples to 16 kHz anyway. The
screenapp lesson that makes this work at all: Playwright adds `--mute-audio`
to Chromium by default, which would make the monitor capture pure silence —
stripping it is asserted by a unit test on the launch profile. _Rejected:_
in-page MediaRecorder capture (above), x11grab video capture (nothing
downstream consumes video).

**D68 — The bot joins device-less ("Continue without microphone and camera"),
with a near-normal launch profile: stealth plugin (`iframe.contentWindow` +
`media.codecs` evasions disabled), no fake-device flags, locale pinned to
English (`hl=en` + `en-US` context).**
screenapp's Google lane found Meet fingerprints hardest _before admission_ and
deliberately keeps launch flags minimal there, joining without devices; Vexa
needs fake devices only for its TTS speak path, which we don't have. Device-less
also means the bot cannot unmute, ever — a nice property for a consent-first
product. Locale pinning replaces prior art's per-language selector tables
(we control the browser, so multilingual text matching is self-inflicted
complexity). Both prior arts independently ship the same stealth-plugin config,
which is strong evidence it's the working combination. Anonymous join is the
default; a dedicated signed-in profile (`BOT_STORAGE_STATE_PATH`) is the
documented fallback for orgs that block anonymous guests (meet-bot.md).
_Rejected:_ `--use-fake-device-for-media-stream` on the Meet lane (the old
meet-bot.md draft), per-locale selector variants.

**D69 — Bot recordings enter the pipeline through one `meeting.finalize` path:
segments are crash insurance only; a slicer-worker handler concatenates them
(silence-padding wall-clock gaps), uploads the canonical file, and publishes a
plain `meeting.uploaded`. Supersedes the "skip the slicer" half of D32.**
The 5.1 review caught that D32's free-chunks idea doesn't survive contact with
the invariants: `-f segment` produces _non-overlapping_ segments, while the
stitcher's dedup rules assume the 10 s overlap (D46/2.1), and diarization needs
the concatenated full file regardless — so someone must concatenate anyway, and
a zero-overlap mode would fork the racing engine's tested behavior for one
producer. Segment keys embed `{idx}_{startedAtMs}` so the finalize handler can
rebuild the absolute timeline with no metadata store, inserting silence for
crash/rejoin gaps (invariant 4 — timestamps stay absolute). Clean leave and
crash converge on the same finalize job (`{meetingId}:finalize:0`,
deterministic, idempotent, normal retry ladder), which is exactly the shape the
2.7 chaos tests already exercise. Cost of rejected purity: re-slicing seconds
of CPU and one ~30 MB round trip per meeting. _Rejected:_ bot segments as
racing-engine chunks (no overlap), overlapped double-recording in the bot
(two ffmpeg processes to fake overlap), a zero-overlap stitch mode (forks
D46's invariants), bot-side concat on clean exit only (two code paths where
crash is the one that must work).

**D70 — The bot container holds zero infrastructure credentials: an
orchestrator HTTP control plane (heartbeat / events / per-segment presigned
PUT URLs) with a random per-session token is the bot's only egress into our
system.**
The bot runs a full browser rendering attacker-adjacent content (whatever a
meeting participant does), so it is the most exposed process in the product —
7.1 will treat its container-escape surface as a headline item. Giving it R2,
Postgres, or RabbitMQ credentials would make every Meet UI exploit a pivot
into the data plane; presigned PUTs scoped to
`tenant/{t}/meeting/{m}/bot-segments/` cap the blast radius at "can upload
audio bytes to its own meeting." The orchestrator owns R2/DB/AMQP, records
`bot_sessions` through tenant-scoped repositories (invariant 2 — the missing
`tenant_id` column is added in 5.5's migration), and forwards state to the
events exchange for SSE. Consistent with invariant 1: media bytes go
client→R2; the API and orchestrator only mint URLs and enqueue. _Rejected:_
AMQP/R2 credentials inside the bot container, bot→API status calls (the API
shouldn't hold dockerode/bot session state), stdout-parsing as a control
channel (no backchannel for presigned URLs).

**D71 — Join/admission outcomes are a first-class taxonomy (`not_admitted`,
`denied`, `blocked`, `invalid_url`, plus in-call `removed`); admission is
detected by a participant-count signal, never by button presence; ≤3
ask-to-join requests per admission window, denial always terminal; one
automatic rejoin after an unexpected mid-meeting death.**
screenapp's field experience: the "Leave call" button exists _while still in
the lobby_, so admission tests on it produce recordings of the waiting room —
the reliable signal is the participant count (`[data-avatar-count]` badge,
`People - N joined` aria-label) combined with the absence of lobby text. Meet
also silently expires ask-to-join requests ("No one responded to your
request") and sometimes redirects mid-wait, so a bounded re-request loop is
required — but 3 total asks, not prior art's 10 (a host who ignored two asks
has answered; D33's trust posture applies). A crash mid-meeting gets exactly
one fresh-container rejoin: the host sees one extra admission prompt, and the
D69 silence padding absorbs the audio gap. _Rejected:_ admission via
leave-button presence (lobby false positive), unlimited join-request retries
(spam), auto-rejoin loops, retrying after an explicit denial.

**D72 — Bot concurrency is a static semaphore `BOT_MAX_CONCURRENT`, default
1; the RAM budget affords 2; no diarization-aware dynamic gating.**
Resolves the doc drift between D31 ("caps concurrency at 1", written before
D42 freed 3 GB) and infrastructure.md's post-D42 budget ("2, or 1 while
diarization is at peak"). Coupling spawn admission to live pipeline load means
the orchestrator polling worker state to decide whether a bot may join a
meeting — real complexity, and at demo scale the second concurrent meeting is
rare enough that a static operator-set cap covers it. Default ships at 1
(CLAUDE.md invariant 6's conservative reading); an operator can set 2, which
the budget table explicitly reserves. _Rejected:_ dynamic
diarization-load-aware semaphore, hardcoding the cap.

**D73 — `BOT_CONFIG` carries `sessionId`/`orchestratorUrl`/`platform` alongside
meet-bot.md's documented "meeting id, Meet URL, display name, session token."**
5.5 implementation: the control-plane client (D70) needs to know its own
session id (path segment on every call) and where the orchestrator listens
(`CONTROL_PLANE_HOST`/`PORT`), and the platform strategy interface (Zoom,
Phase 8) needs a selector too — none of those are derivable from the four
originally-listed fields. Smallest compliant extension of the documented
shape, not a redesign. _Rejected:_ a second env var (one JSON blob is
simpler to pass through `docker run`'s env array than several).

**D74 — `q.slicer`'s two message shapes (`meeting.uploaded`, `meeting.finalize`,
D69) are told apart by a `type` discriminator field on the message itself,
defaulted for backward compatibility.**
5.3 implementation: `framework.py`'s `Handler` signature is `(payload, ctx)`
with no routing key (workers/scribeflow_workers/framework.py), so a queue
bound to two routing keys has no other way to dispatch without changing
that signature for every existing worker. Mirrors the `type` field
`PipelineEventV1` already uses on the events fanout for the same reason —
consistent with, not a departure from, existing convention.
`meetingUploadedV1`'s new `type` field defaults to `"meeting.uploaded"` on
both sides of the wire (CLAUDE.md: additive schema changes only) so it
parses identically whether or not a sender sets it explicitly. _Rejected:_
threading a routing key through `framework.py`'s Handler/JobContext (a
wider, riskier change to every existing worker for one queue's benefit).

**D75 — `bot_sessions` gets a `meet_url` column beyond the documented
tenant_id/last_heartbeat_at/outcome_detail additions.**
5.5 implementation: the reaper's one-automatic-rejoin (D71) needs the
original Meet URL to relaunch a fresh container, and by the time it fires
the original `bot.spawn` message is long gone — it stays unacked, not
requeued, for the session's whole lifetime (D77). Persisting it on the
session row is the only place left to get it from. Since `bot_sessions`
had never been migrated before this ticket (the Phase 0 sketch was schema
prose only), this landed in the same initial `CREATE TABLE` rather than a
later `ALTER`. _Rejected:_ re-deriving the Meet URL from `meetings.meet_url`
(a bot invited without a stored `meetUrl`, via the "invite bot now"
endpoint's override, would have no fallback).

**D76 — `meeting.finalize` sorts a bot's uploaded segments by wall-clock
`startedAtMs`, not by the `idx` embedded in the segment key.**
5.3 implementation clarification of meet-bot.md's "lists the segment prefix,
sorts by index": a rejoin (D71) spawns a fresh ffmpeg process whose own
segment index restarts at 0 (`Capture` in bot/src/capture.ts always begins
a new session at `seg_000`), so `idx` alone can collide across a rejoin
while the embedded wall-clock start time stays monotonic. Sorting by
`startedAtMs` is what makes the silence-padding gap computation (D69)
correct across a crash/rejoin boundary, which is the exact scenario the
padding exists for. _Rejected:_ sorting by idx as literally written (breaks
under the one documented crash-recovery path this feature exists to serve).

**D77 — The `BOT_MAX_CONCURRENT` static semaphore (D72) is implemented as
the orchestrator's AMQP channel prefetch on `q.bot_spawn`; a spawn message
is acked only once its session reaches a terminal state.**
5.5 implementation: meet-bot.md specifies the semaphore's existence and
default but not its mechanism. RabbitMQ won't deliver more than `prefetch`
unacked messages to a consumer, so holding a spawn message unacked for a
session's entire lifetime (recorded meeting length included) _is_ the
concurrency cap, with no extra state to keep in sync — the alternative
(track an in-memory counter, nack/requeue-with-delay when at capacity) adds
a second source of truth that can drift from reality on a crash. The
job-key idempotency check (invariant 3, `{meetingId}:bot:0`) still guards
against a redelivery after an orchestrator restart double-spawning.
_Rejected:_ an in-memory counter with delayed requeue, a Postgres advisory
lock (D24's pattern, but this isn't a rate limit — it's "how many
in-flight," which prefetch already models for free).

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

**D42 — No ClickHouse in v1: analytics live in Postgres; Phase 4 becomes a
stretch phase. (Supersedes D17/D18 for v1.)**
Deep asked the right question before Phase 1: the product he's building — bot
joins the meeting, user gets the transcript/summary/action items by email or
dashboard, plus the agent layer — never touches ClickHouse. It served only the
Phase 4 analytics dashboard, and at portfolio scale utterances number in the
thousands, where Postgres aggregates instantly; keeping it was partly
resume-driven (D17 admitted "portfolio signal" as a factor). Dropping it frees
3 GB of the 12 GB RAM budget — enough for a **second concurrent bot meeting** —
and removes a whole service from the ops surface. The interview story improves,
not worsens: "Postgres now, ClickHouse when utterances hit millions — here's the
retained design (D17/D18)" demonstrates judgment. RabbitMQ explicitly **stays**:
it is the racing engine's backbone (fan-out/fan-in, retries/DLQ, polyglot
consumers), not decoration. _Rejected:_ dropping RabbitMQ too (reduces the
project to bot + API-call glue — the thin-agent shape rejected in D4), and
keeping ClickHouse as-is (a 3 GB service with no v1 reader).
