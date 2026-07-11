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
| Analytics DB   | ClickHouse                                                 | Oracle VM (Docker)                    |
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
4. **Racing branch** (`transcriber` workers, N-concurrent): each downloads its byte
   range/chunk file, calls Groq Whisper, shifts timestamps by the chunk offset,
   writes segments to Postgres, decrements the fan-in counter.
5. **Diarization branch** (`diarizer` worker): pyannote on the full file → speaker
   turns `[(speaker_label, start, end)]` → Postgres.
6. **Fan-in** (`stitcher`): when the chunk counter hits zero _and_ diarization is
   done, stitches chunks, merges speakers, marks transcript final.
7. **Intelligence** (`extractor`): LLM pass for action items / decisions / summary;
   sentiment pass per utterance.
8. **Analytics ingest**: final utterances batch-inserted into ClickHouse.
9. **Notify**: API pushes SSE events at every state transition; dashboard updates live.

## The racing engine

**Problem:** a 1-hour file transcribed serially is slow and a single point of
failure. **Approach:** slice → parallel map → deterministic reduce.

### Slicing

- Chunk length 300 s with 10 s overlap: chunk _i_ covers `[i·290, i·290 + 300]`.
  Overlap exists so no word is lost at a boundary; ffmpeg cuts by `-ss/-t` on the
  already-downloaded file (stream copy for formats that allow it, re-encode to
  16 kHz mono FLAC otherwise — smaller uploads to Groq, no quality loss).
- Each chunk job carries `{meeting_id, chunk_idx, offset_s, total_chunks}`.

### Parallel transcription

- Workers request word/segment timestamps (`verbose_json`). All timestamps are
  shifted by `offset_s` before storage, so every stored segment is already in
  absolute meeting time.
- Groq free tier allows 20 req/min: a 60-min meeting is 13 chunks → one burst.
  A token-bucket limiter shared via Postgres advisory lock keeps concurrent
  meetings inside the quota.

### Deterministic stitching

For the overlap window between chunk _i_ and _i+1_ (`[ (i+1)·290, i·290+300 ]`):

1. Take segments from both chunks that intersect the window.
2. The cut point is the **midpoint of the overlap** (`(i+1)·290 + 5`); chunk _i_
   keeps segments whose midpoint is before the cut, chunk _i+1_ keeps the rest.
3. If a segment straddles the cut, prefer the version from the chunk where it sits
   further from that chunk's edge (Whisper is least reliable at chunk edges).
4. Ties broken by chunk index — the same inputs always produce the same transcript
   (this is what "deterministic" buys: retries and duplicate deliveries are safe).

Chunk failure → per-chunk retry (3×, exponential backoff via DLQ TTL); a chunk that
exhausts retries marks the transcript `partial` with a gap marker rather than
failing the meeting.

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
  analytics.ingest   → q.ch-ingest
each queue → paired DLQ with 30s/2m/10m retry TTLs, then parking-lot queue
```

- **Idempotency:** every job has a deterministic ID (`{meeting_id}:{stage}:{chunk_idx}`);
  workers upsert results keyed on it, so redelivery is harmless.
- **Fan-in without a race:** `UPDATE meetings SET chunks_done = chunks_done + 1
WHERE id = $1 RETURNING chunks_done` — the worker that sees
  `chunks_done = total_chunks` publishes `meeting.stitch`. Single atomic statement,
  no distributed lock.

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
action_items(id, meeting_id, tenant_id, text, owner_user_id, due_date,
             confidence, status, source_segment_id)
bot_sessions(id, meeting_id, container_id, state, joined_at, left_at, error)
```

### ClickHouse (analytics, append-only)

```sql
CREATE TABLE utterances (
  tenant_id UUID, meeting_id UUID, speaker String,
  ts_start DateTime64(3), duration_s Float32,
  word_count UInt16, sentiment Float32,   -- [-1, 1]
  is_interruption UInt8, is_question UInt8
) ENGINE = MergeTree
ORDER BY (tenant_id, meeting_id, ts_start);
```

Materialized views pre-aggregate per (tenant, speaker, day): talk seconds,
interruption count, question count, avg sentiment. Dashboard queries hit the MVs;
raw-utterance drill-down hits the base table. This is what keeps "team analytics
over millions of rows" interactive on a shared 12 GB VM.

## Multi-tenancy

- JWT carries `tenant_id`; a single Fastify `preHandler` injects it into a
  request-scoped context; all repository functions **require** it as a parameter
  (no default), so forgetting scoping is a compile error, not a data leak.
- R2 keys are prefixed `tenant/{tenant_id}/…` and presigned URLs are generated
  server-side only for the caller's own prefix.
- ClickHouse queries go through one query-builder that always injects the
  `tenant_id` predicate (it's also the first ORDER BY key, so it's cheap).

## Real-time dashboard

SSE (not WebSocket): updates are one-directional and infrequent, SSE is plain
HTTP through any proxy (Caddy included) and auto-reconnects for free. API keeps a per-tenant
subscriber set; pipeline workers publish state transitions to a `events` fanout
exchange that the API consumes and forwards.
