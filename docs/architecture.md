# Architecture

## Components

| Component      | Tech                                                       | Runs on                               |
| -------------- | ---------------------------------------------------------- | ------------------------------------- |
| Web dashboard  | React (Vite) + SSE client                                  | Vercel (D40)                          |
| API            | Node.js + Fastify + Zod                                    | Oracle VM (Docker)                    |
| Queue          | RabbitMQ (quorum queues + DLQ)                             | Oracle VM (Docker)                    |
| Workers        | Python 3.12 (`pika`, `ffmpeg`, `pyannote.audio`, Groq SDK) | Oracle VM (Docker)                    |
| Meet bot       | Node.js + Playwright + Xvfb + PulseAudio                   | Ephemeral Docker containers on the VM |
| State DB       | Postgres 16                                                | Oracle VM (Docker)                    |
| Analytics      | Postgres aggregates (D42; ClickHouse deferred)             | Oracle VM (Docker)                    |
| Object storage | Cloudflare R2 (S3 API)                                     | Cloudflare                            |
| Ingress        | Caddy (auto Let's Encrypt TLS, D39)                        | VM :443                               |

The single-VM layout is deliberate: one Docker Compose file, no cross-network
latency, fits in 12 GB RAM (see budget in [infrastructure.md](infrastructure.md)).
Every service is stateless except the databases, so scaling out later means moving
containers to more hosts and pointing them at the same RabbitMQ — the queue-centric
design is what makes that a config change, not a rewrite.

## Data flow (happy path)

1. **Acquire audio.** Either the Meet bot uploads its recording, or a user requests
   `POST /meetings/:id/upload-url` and PUTs the file directly to R2 with a presigned
   URL (max 500 MB, content-type audio/*, key scoped to `tenant/{id}/meeting/{id}`).
   The API never touches media bytes.
2. **Enqueue.** API publishes `meeting.uploaded {tenant_id, meeting_id, r2_key,
duration_hint}` to the `pipeline` exchange.
3. **Probe + slice** (`slicer` worker): ffprobe for duration, then two parallel
   branches are kicked off:
   - publishes one `chunk.transcribe` job per slice (racing branch)
   - publishes one `meeting.diarize` job for the full file (diarization branch)
4. **Racing branch** (`transcriber` workers, N-concurrent): each downloads its
   chunk file from R2 (D47), calls Groq Whisper, shifts timestamps by the chunk
   offset, writes segments to Postgres, increments the fan-in counter.
5. **Diarization branch** (`diarizer` worker): pyannote on the full file → speaker
   turns `[(speaker_label, start, end)]` → Postgres.
6. **Fan-in** (`stitcher`): when `chunks_done` reaches `total_chunks` _and_
   diarization is done, stitches chunks, merges speakers, marks transcript final.
7. **Intelligence** (`extractor`): LLM pass for action items / decisions / summary;
   sentiment pass per utterance.
8. **Metrics** (stretch, D42): per-speaker utterance metrics (talk seconds,
   interruptions, sentiment) written to Postgres at stitch time.
9. **Notify**: API pushes SSE events at every state transition; dashboard updates
   live, and the summary email (with action items) goes out for approval.

## The racing engine

**Problem:** a 1-hour file transcribed serially is slow and a single point of
failure. **Approach:** slice → parallel map → deterministic reduce.

### Slicing

- Chunk length 300 s with 10 s overlap: chunk _i_ covers `[i·290, i·290 + 300]`.
  Overlap exists so no word is lost at a boundary.
- **Chunk count** (D46): with ffprobe duration `D`,
  `n = max(1, ceil((D − 10) / 290))` and the final chunk runs to end-of-file
  (`-ss` only, no `-t`). If the final chunk would be shorter than **30 s**, it
  is absorbed: `n` drops by one and the now-last chunk extends to end-of-file
  (≤ 330 s — still far inside Groq's 100 MB/request cap as FLAC). `D ≤ 300 s`
  degenerates to one chunk with `offset_s = 0`, the Phase 1 single-shot shape.
- Chunks are always **re-encoded to 16 kHz mono FLAC** (D47), never stream
  copied: decode→resample→encode gives sample-exact cut points, so `offset_s`
  is exact (invariant 4), and Groq receives a uniform input regardless of the
  source container. Stream copy cuts at packet/keyframe granularity and its
  actual start time can drift from the requested `-ss` — an offset error that
  D16 exists to prevent.
- The slicer uploads each chunk to R2 at
  `tenant/{tenantId}/meeting/{meetingId}/chunks/{idx}.flac` (same 30-day
  lifecycle prefix as the original; no active cleanup needed). Each
  `chunk.transcribe` job carries
  `{v, tenant_id, meeting_id, chunk_idx, total_chunks, offset_s, r2_key}`
  where `r2_key` is the **chunk object**, not the original upload. _Rejected:_
  byte-range downloads of the original — byte ranges of compressed containers
  aren't independently decodable.
- Ordering on first run: the slicer claims its job (`{meetingId}:slice:0`),
  ffprobes, commits `total_chunks = n, duration_s = D` **before publishing any
  chunk job** — guarded by `AND total_chunks = 0` so a redelivered slicer job
  never resets counters mid-flight — then publishes the `n` chunk jobs plus one
  `meeting.diarize` job, sets status `transcribing`, and completes its job.
  Re-slicing is deterministic (same `D` → same cuts) and chunk jobs are
  idempotent, so duplicate publishes are harmless.

### Parallel transcription

- Workers request word/segment timestamps (`verbose_json`). All timestamps are
  shifted by `offset_s` before storage, so every stored segment is already in
  absolute meeting time.
- Groq free tier allows 20 req/min: a 60-min meeting is 13 chunks → one burst.
  A token-bucket limiter shared via Postgres advisory lock keeps concurrent
  meetings inside the quota.

### Deterministic stitching

Segments are the atomic unit: they are **kept or dropped whole, never split** —
`words_jsonb` rides along with its segment. All rules below operate on absolute
meeting time (timestamps were already shifted at the chunk worker, D16).

Define cut points `c_i = (i+1)·290 + 5` — the midpoint of the overlap between
chunk _i_ and _i+1_ — with `c_{-1} = −∞` and `c_{n-1} = +∞`.

1. **Side assignment.** Chunk _i_ keeps exactly those of its segments whose
   temporal midpoint `(start + end) / 2` lies in `[c_{i-1}, c_i)`; the rest of
   its segments are dropped. Half-open intervals mean a midpoint landing
   exactly on a cut belongs to the later chunk — no segment can be claimed by
   both sides or by neither.
2. **Cross-cut duplicate sweep.** The same utterance can survive rule 1 twice
   when Whisper timestamps it slightly differently in each chunk (one version's
   midpoint just before `c_i`, the other's just after). After rule 1, for each
   cut `c_i`, compare every kept segment of chunk _i_ against every kept
   segment of chunk _i+1_ that overlaps it in time: if the pair overlaps by
   **more than 50 % of the shorter segment's duration**, they are the same
   utterance — keep the version with the larger **edge distance** and drop the
   other. Edge distance measures how far the segment sits from its source
   chunk's unreliable edge: for chunk _i_ it is `(i·290 + 300) − end`; for
   chunk _i+1_ it is `start − (i+1)·290`. (Whisper is least reliable at chunk
   edges, so the version recorded further from an edge wins.)
3. **Ties** (equal edge distance) go to the lower chunk index.

Positional comparison only — no text matching (LCS-style merging was rejected
in D11; edge hallucinations defeat it). The same inputs always produce the same
transcript, which is what "deterministic" buys: retries and duplicate
deliveries are safe. The stitcher applies rules 1–3 by **deleting** the losing
rows from `transcript_segments` in the same transaction that finalizes the
meeting; re-running the stitch on already-stitched data deletes nothing new
(the rules depend only on surviving rows' positions and chunk indices), so
stitch redelivery is idempotent.

### Silence and hallucinated segments (D48)

Whisper hallucinates on silence (the infamous phantom "thank you for
watching"), most often at chunk edges. Filtering happens **in the chunk
transcriber before storage**, so the stitcher never sees hallucinated
segments:

- `parse_verbose_json` carries each segment's `no_speech_prob`, `avg_logprob`,
  and `compression_ratio` (an additive change to the internal `Segment` model —
  not a queue-contract change).
- Drop a segment when `no_speech_prob > 0.6` **and** `avg_logprob < −1.0`
  (Whisper's own non-speech heuristic), or independently when
  `compression_ratio > 2.4` (repetition hallucination).
- A chunk yielding **zero segments** after filtering (silence, hold music, a
  leading/trailing dead zone) is a _success_: it writes no rows and completes
  fan-in like any other chunk. An entirely silent meeting finalizes as `done`
  with an empty transcript — `duration_s` comes from the slicer's ffprobe, not
  from segment timestamps.

### Chunk failure → gaps (D49)

Per-chunk retries follow the standard ladder (D43: 3 retries via tiered TTL
queues, then parking). What "marks the transcript partial with a gap marker"
means precisely:

- The `job_status` enum gains a terminal **`exhausted`** state. The chunk
  transcriber's exhausted-hook transitions the job row
  (`… SET status = 'exhausted' WHERE job_key = $1 AND status <> 'exhausted'`)
  and, **only if that update transitioned a row**, increments `chunks_done` in
  the same transaction — the conditional update is the exactly-once guard, so
  a duplicate parking delivery can't double-count. Any permanent failure path
  (`PermanentError` included) routes through this same hook. After commit the
  hook runs the same stitch-trigger check as a successful completion ("Fan-in
  mechanics" below) — an exhausted chunk can be the one that closes fan-in.
  The meeting's status is left alone — the stitcher owns the terminal state.
- Fan-in therefore **always closes**, with `chunks_done` counting completed +
  exhausted chunks; a failed chunk can never wedge the meeting in
  `transcribing`.
- At stitch time the stitcher reads the exhausted chunk indices from the jobs
  table and computes the **uncovered intervals**: `[0, D]` minus the union of
  succeeded chunks' coverage (adjacent failed chunks merge into one gap; a
  failed chunk whose whole range is covered by its neighbors' overlap yields
  no gap). Each interval becomes a row in `transcript_gaps` and the viewer
  renders it as a gap marker inline with the segments.
- Terminal status: any gap → `partial`; **zero** chunks succeeded → `failed`;
  otherwise `done`.

### Fan-in mechanics (D50, refining D14)

A chunk's completion is one Postgres transaction: `replace_segments` +
`jobs → 'done'` (conditional, `WHERE status <> 'done'`) + `chunks_done + 1`
(only if the job row transitioned — same exactly-once guard as above),
committed atomically. After commit, the worker checks
`chunks_done = total_chunks AND diarization_done` and publishes
`meeting.stitch` if both hold. The diarizer runs the identical check when it
finishes — whichever branch closes last triggers the stitch. Two crash
windows and their closures:

- _Crash after commit, before publishing stitch_: the redelivered chunk job
  hits `claim_job`'s already-done skip path; on that path the worker re-reads
  the counters and, if fan-in is closed but the meeting is still
  `transcribing`, republishes `meeting.stitch`. The stitcher's own
  `claim_job` makes duplicate stitch messages harmless.
- _Diarization exhausts its retries_: its exhausted-hook sets
  `diarization_done = true` (recording the error on the meeting row) so the
  stitch is never blocked forever; the merge proceeds with `NULL` speakers
  and the terminal status is forced to `partial`.

### Why diarization is NOT chunked

pyannote clusters speaker embeddings **globally** — chunking it would let "Speaker A"
in chunk 1 become "Speaker B" in chunk 4 with no way to reconcile. So diarization
runs once over the full file, in parallel with the racing branch (it's the long pole;
on CPU expect ~0.5–1× real time). The merge step assigns each transcript segment the
speaker whose turn has **maximum temporal overlap** with it; segments overlapping two
turns >30% each are flagged as interruptions (an analytics feature, not a bug).

Speaker labels → human names: match diarized voice count against calendar attendees,
let users confirm/correct in the UI once, then persist a per-tenant voice-print
embedding for future automatic matching (stretch).

## Queue topology

```
exchange: pipeline (topic)
  meeting.uploaded   → q.slicer          (prefetch 1)
  chunk.transcribe   → q.transcriber     (prefetch 4, competing consumers)
  meeting.diarize    → q.diarizer        (prefetch 1 — CPU-bound)
  meeting.stitch     → q.stitcher
  meeting.extract    → q.extractor
exchange: events (fanout) → per-API-instance exclusive queue (SSE forwarding)
each work queue → tiered retry queues (30s/2m/10m TTL), then q.parking
```

> **Phase 1 interim (D45):** until the slicer lands, `meeting.uploaded` binds
> to `q.transcriber` (single-shot transcription, prefetch 1). The topology is
> declared as code in `api/src/queue/topology.ts` and mirrored exactly in
> `workers/scribeflow_workers/topology.py`; both sides assert it on connect.
>
> **Retry mechanics (D43):** the worker framework republishes a failed message
> to the retry tier matching its `x-attempts` header and acks the original;
> retry queues dead-letter back to the work queue by name via the default
> exchange. After 4 total attempts the message is parked with error headers
> and the worker's exhausted-hook marks the meeting failed.

- **Idempotency:** every job has a deterministic ID (`{meeting_id}:{stage}:{chunk_idx}`);
  workers upsert results keyed on it, so redelivery is harmless.
- **Fan-in without a race:** `UPDATE meetings SET chunks_done = chunks_done + 1
WHERE id = $1 RETURNING chunks_done` — the worker that sees
  `chunks_done = total_chunks` publishes `meeting.stitch`. Single atomic statement,
  no distributed lock. Exactly-once increment guards and the crash-window
  closures are specified in "Fan-in mechanics" above (D50).

## Storage schemas

### Postgres (state, source of truth)

```
tenants(id, name, slug, created_at)
users(id, tenant_id, email, name, role, google_refresh_token_enc)
meetings(id, tenant_id, title, calendar_event_id, meet_url, started_at,
         duration_s, status, r2_key, total_chunks, chunks_done,
         diarization_done, error)
transcript_segments(id, meeting_id, chunk_idx, speaker, start_s, end_s,
                    text, words_jsonb)
transcript_gaps(id, meeting_id, start_s, end_s, reason)   -- written at stitch (D49)
action_items(id, meeting_id, tenant_id, text, owner_user_id, due_date,
             confidence, status, source_segment_id)
bot_sessions(id, meeting_id, container_id, state, joined_at, left_at, error)
```

### Analytics (Postgres for v1 — D42)

Per-speaker metrics (talk seconds, interruption/question counts, sentiment) are
computed at stitch time into a `utterance_metrics` table (Phase 4, stretch) and
aggregated with plain SQL — at portfolio scale that's thousands of rows, which
Postgres serves instantly. The original ClickHouse design (MergeTree ordered by
`(tenant_id, meeting_id, ts_start)` + per-day materialized views) is retained in
D17/D18 as the documented migration path if utterances ever reach the millions.

## Multi-tenancy

- JWT carries `tenant_id`; a single Fastify `preHandler` injects it into a
  request-scoped context; all repository functions **require** it as a parameter
  (no default), so forgetting scoping is a compile error, not a data leak.
- R2 keys are prefixed `tenant/{tenant_id}/…` and presigned URLs are generated
  server-side only for the caller's own prefix.
- Analytics aggregates go through repository functions like everything else —
  same required-`tenantId` rule, no separate query path to forget scoping in.

## Real-time dashboard

SSE (not WebSocket): updates are one-directional and infrequent, SSE is plain
HTTP through any proxy (Caddy included) and auto-reconnects for free. API keeps a per-tenant
subscriber set; pipeline workers publish state transitions to a `events` fanout
exchange that the API consumes and forwards.
