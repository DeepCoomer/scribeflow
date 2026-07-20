import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  doublePrecision,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";

// pgvector (ticket 3.5, D63): drizzle-orm has no built-in vector type, so
// this is the standard customType shim — pgvector's text I/O format
// ("[0.1,0.2,...]") happens to already be valid JSON array syntax, so
// fromDriver can just JSON.parse it. 384 dims matches
// sentence-transformers/all-MiniLM-L6-v2 (workers/embed_backends.py) and
// Xenova/all-MiniLM-L6-v2 (the API's query-time embedding, api/src/lib/
// embeddings.ts) — both are ONNX/torch exports of the same weights, so the
// two sides land in the same vector space.
const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(384)";
  },
  toDriver(value) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value) {
    return JSON.parse(value) as number[];
  },
});

// --- tenants -----------------------------------------------------------
// The root of tenant scoping (D20). Every other table below either carries
// tenant_id directly or reaches it in one join (jobs -> meetings).

export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// --- users ---------------------------------------------------------------

export const userRoleEnum = pgEnum("user_role", ["owner", "admin", "member"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: userRoleEnum("role").notNull().default("member"),
    // Null for users who only ever sign in via Google OAuth.
    passwordHash: text("password_hash"),
    googleId: text("google_id"),
    googleRefreshTokenEnc: text("google_refresh_token_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Email is globally unique, not per-tenant: it's the login lookup key
    // before a tenant is known (see D20 exception in repositories/users.ts).
    uniqueIndex("users_email_idx").on(t.email),
    uniqueIndex("users_google_id_idx").on(t.googleId),
  ],
);

// --- meetings --------------------------------------------------------------
// Mirrors the shape in docs/architecture.md; transcript_segments and
// bot_sessions land in Phase 1 / Phase 5 tickets, not here.

export const meetingStatusEnum = pgEnum("meeting_status", [
  "pending",
  "uploading",
  "processing",
  "transcribing",
  "partial",
  "done",
  "failed",
]);

export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    calendarEventId: text("calendar_event_id"),
    meetUrl: text("meet_url"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    durationS: integer("duration_s"),
    status: meetingStatusEnum("status").notNull().default("pending"),
    r2Key: text("r2_key"),
    totalChunks: integer("total_chunks").notNull().default(0),
    chunksDone: integer("chunks_done").notNull().default(0),
    diarizationDone: boolean("diarization_done").notNull().default(false),
    // Set by the diarizer's exhausted-hook (D50); non-null tells the
    // stitcher diarization gave up, forcing the terminal status to
    // `partial` even when every chunk transcribed cleanly.
    diarizationError: text("diarization_error"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Postgres doesn't index FK columns automatically; this backs the
  // dominant query ("recent meetings for tenant X") per ticket 0.6 review.
  (t) => [index("meetings_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

// --- jobs --------------------------------------------------------------
// Audit/dedup ledger backing the deterministic job IDs invariant (D15):
// the queue gives at-least-once delivery, this table is what lets a worker
// check "have I already done {meetingId}:{stage}:{chunkIdx}?" idempotently.

export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "running",
  "done",
  "failed",
  // Terminal: retries exhausted (D49). Distinct from "failed" (which the
  // job ledger already used for a single failed attempt still eligible for
  // retry) — "exhausted" is what the retry ladder's parking lot means.
  "exhausted",
]);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    // Deterministic: "{meetingId}:{stage}:{chunkIdx}" per D15.
    jobKey: text("job_key").notNull(),
    stage: text("stage").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_job_key_idx").on(t.jobKey),
    // For "all jobs of meeting X" (status page, stitcher fan-in check).
    index("jobs_meeting_idx").on(t.meetingId),
  ],
);

// --- action_items --------------------------------------------------------

export const actionItemStatusEnum = pgEnum("action_item_status", [
  "open",
  "done",
  "dismissed",
]);

export const actionItems = pgTable(
  "action_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    // Free-text owner name the extractor read off the transcript (a speaker
    // display name, most often) — never auto-resolved to a real account (D59,
    // same "candidate, not assignment" caution as D56's calendar names).
    // ownerUserId is the real assignment, set only via the 3.3 UI's explicit
    // "assign" action.
    ownerName: text("owner_name"),
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    // 0..1 LLM extraction confidence; drives review-queue triage later.
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    status: actionItemStatusEnum("status").notNull().default("open"),
    // Advisory nearest-segment link for the "jump to transcript" UI (D59):
    // no FK by design, since a re-stitch deletes and reinserts
    // transcript_segments with new ids (D11/D49) and would silently orphan
    // any FK-constrained reference. A dangling id here just means the UI
    // link 404s harmlessly.
    sourceSegmentId: uuid("source_segment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Ticket 3.8: set by the nudger's daily scan when it actually sends an
    // owner a digest email for this item — compared against "start of
    // today" (not just "is it null") so an item stays nudge-eligible once
    // per day for as long as it's open and overdue, instead of only ever
    // once (D66).
    lastNudgedAt: timestamp("last_nudged_at", { withTimezone: true }),
  },
  // Backs the action-items dashboard ("open items for tenant X") and the
  // Phase 3b nudge agent's daily scan (open + past due), per 0.6 review.
  (t) => [index("action_items_tenant_status_idx").on(t.tenantId, t.status)],
);

// --- transcript_segments ---------------------------------------------------
// Written by the transcription workers (Phase 1: single-shot, chunk_idx 0;
// Phase 2: one writer per chunk). No tenant_id column by design
// (docs/architecture.md schema): reads join through meetings, and repository
// functions still require tenantId (D20). start_s/end_s are ABSOLUTE meeting
// time — workers shift by the chunk offset before persisting (invariant 4).

export const transcriptSegments = pgTable(
  "transcript_segments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    chunkIdx: integer("chunk_idx").notNull().default(0),
    // Null until the diarization merge assigns one (Phase 2, ticket 2.6).
    speaker: text("speaker"),
    startS: doublePrecision("start_s").notNull(),
    endS: doublePrecision("end_s").notNull(),
    text: text("text").notNull(),
    wordsJsonb: jsonb("words_jsonb"),
    // Ticket 3.2: per-utterance sentiment, written by the extractor worker's
    // batched sentiment pass after the transcript is final. Null until that
    // pass runs (or if it never does — sentiment is best-effort, not part of
    // the pipeline's terminal-status contract). -1..1, negative to positive.
    sentimentLabel: text("sentiment_label"),
    sentimentScore: doublePrecision("sentiment_score"),
    // Ticket 3.5 (D63): written by the embedder worker once per segment,
    // null until that best-effort pass runs (same "enhancement, not part of
    // the terminal-status contract" shape as sentiment above). The cosine
    // HNSW index this needs (`vector_cosine_ops`) isn't expressible through
    // drizzle-kit's index builder, so it's hand-added in the migration SQL
    // instead of declared here — see api/drizzle/0006_*.sql.
    embedding: vector384("embedding"),
  },
  (t) => [
    // The viewer reads a whole meeting ordered by time; the idempotent
    // replace-by-chunk write path deletes by (meeting, chunk).
    index("transcript_segments_meeting_start_idx").on(t.meetingId, t.startS),
    index("transcript_segments_meeting_chunk_idx").on(t.meetingId, t.chunkIdx),
  ],
);

// --- transcript_gaps ---------------------------------------------------------
// Written by the stitcher (D49) when one or more chunks exhausted retries:
// each row is an uncovered interval of meeting time, replacing (delete +
// reinsert) on every stitch run so a redelivered stitch can't duplicate rows.

export const transcriptGaps = pgTable("transcript_gaps", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  startS: doublePrecision("start_s").notNull(),
  endS: doublePrecision("end_s").notNull(),
  reason: text("reason").notNull(),
});

// --- speaker_turns -----------------------------------------------------------
// Raw pyannote output (ticket 2.5) — one row per speaker turn on the full
// file. The 2.6 merge (in the stitcher) reads this alongside
// transcript_segments to assign a speaker to each segment by maximum
// temporal overlap (D13/D55). Retained after the merge (D57): idempotent
// re-stitching recomputes from it, and Phase 4.1's interruption metric
// reads it too.

export const speakerTurns = pgTable("speaker_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  speakerLabel: text("speaker_label").notNull(),
  startS: doublePrecision("start_s").notNull(),
  endS: doublePrecision("end_s").notNull(),
});

// --- meeting_speakers ---------------------------------------------------------
// Label -> human name map (ticket 2.6, D56). transcript_segments.speaker
// keeps the raw diarization label (SPEAKER_00, ...) as a stable key; this
// table is the only place a display name lives, so renaming a speaker is a
// one-row update instead of a sweep over every segment. The stitcher seeds
// one row per label it sees with a "Speaker N" default (numbered by first
// turn start) via ON CONFLICT DO NOTHING, so a re-stitch never clobbers a
// user's rename. No tenant_id column, same as transcript_segments — reads
// and writes join through meetings, and repository functions still require
// tenantId (D20).

export const speakerSourceEnum = pgEnum("speaker_source", [
  "default",
  "user",
  "calendar",
  "voiceprint",
]);

export const meetingSpeakers = pgTable(
  "meeting_speakers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    speakerLabel: text("speaker_label").notNull(),
    displayName: text("display_name").notNull(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    source: speakerSourceEnum("source").notNull().default("default"),
  },
  (t) => [
    uniqueIndex("meeting_speakers_meeting_label_idx").on(t.meetingId, t.speakerLabel),
  ],
);

// --- meeting_summaries ---------------------------------------------------
// One row per meeting (ticket 3.1, D59): the extractor's summary + decisions
// pass, upserted by meeting_id so a redelivered meeting.extract job overwrites
// rather than duplicates (idempotency, D15) — unlike action_items, a summary
// has no natural per-row identity to replace-by-delete, so upsert is the
// right shape here instead of the delete+insert pattern used elsewhere.
// emailSentAt is null until a human clicks "send" (CLAUDE.md: approval-gated
// email, never auto-sent) via the 3.4 endpoint.

export const meetingSummaries = pgTable(
  "meeting_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    decisionsJsonb: jsonb("decisions_jsonb").notNull(),
    model: text("model").notNull(),
    emailSentAt: timestamp("email_sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("meeting_summaries_meeting_idx").on(t.meetingId)],
);

// --- meeting_followups ---------------------------------------------------
// Ticket 3.7: the human-in-the-loop follow-up email (CLAUDE.md — drafts,
// never auto-sends). Unlike meeting_summaries there's no separate "draft"
// state to persist: the API composes a default draft on GET from the
// existing summary/action-items data (no extra LLM call, D65), the user
// edits it client-side, and only the body that actually got sent is
// recorded here — upserted by meeting_id (one row per meeting, same
// replace-on-resend shape as meeting_summaries.emailSentAt).

export const meetingFollowups = pgTable(
  "meeting_followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("meeting_followups_meeting_idx").on(t.meetingId)],
);

// --- bot_sessions ---------------------------------------------------------
// Phase 5 (tickets 5.2-5.5): one row per Meet-bot container spawn attempt.
// The Phase 0 sketch (docs/architecture.md) was never turned into a table
// before this, so the 5.5 additions (tenantId, lastHeartbeatAt,
// outcomeDetail) are realized directly in the initial CREATE TABLE rather
// than as a later ALTER. `state` follows the join/lifecycle taxonomy from
// docs/meet-bot.md exactly (bot/src/state.ts's BOT_STATES — keep both in
// sync in the same commit, same rule as the queue topology mirror).
// containerId/segmentsUploaded/rejoined back the orchestrator's reaper
// (5.5): a heartbeat gone silent > BOT_HEARTBEAT_TIMEOUT_S triggers a
// `docker inspect` by containerId, segmentsUploaded > 0 gates whether
// meeting.finalize gets published, and rejoined caps the "one automatic
// rejoin" rule (D71) per session.

export const botSessionStateEnum = pgEnum("bot_session_state", [
  "spawning",
  "joining",
  "lobby",
  "recording",
  "leaving",
  "done",
  "not_admitted",
  "denied",
  "blocked",
  "invalid_url",
  "failed",
]);

export const botSessions = pgTable(
  "bot_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    meetingId: uuid("meeting_id")
      .notNull()
      .references(() => meetings.id, { onDelete: "cascade" }),
    // Deterministic per invariant 3: "{meetingId}:bot:0" — one non-terminal
    // session per meeting (5.5's queue consumer checks this before spawning).
    jobKey: text("job_key").notNull(),
    // Carried over from the bot.spawn message so the reaper's one-automatic
    // -rejoin (D71) can relaunch without needing the original message —
    // it's long gone by then (the spawn message stays unacked, not
    // requeued, for the session's whole lifetime, D72).
    meetUrl: text("meet_url").notNull(),
    containerId: text("container_id"),
    state: botSessionStateEnum("state").notNull().default("spawning"),
    // Per-session control-plane auth (D70) — the bot container gets this
    // and nothing else; every /sessions/:id/* call is checked against it.
    sessionToken: text("session_token").notNull(),
    segmentsUploaded: integer("segments_uploaded").notNull().default(0),
    rejoined: boolean("rejoined").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    error: text("error"),
    outcomeDetail: text("outcome_detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("bot_sessions_job_key_idx").on(t.jobKey),
    // The reaper's "who's gone quiet" scan and the dashboard's live status
    // both filter by tenant + non-terminal state.
    index("bot_sessions_tenant_state_idx").on(t.tenantId, t.state),
  ],
);

// --- rate_limiter_buckets ---------------------------------------------------
// Backing row for the shared Groq token bucket (D24): workers take a Postgres
// advisory lock keyed on the bucket, refill tokens by elapsed time, and spend
// one per request — org-wide 20 req/min regardless of worker count. One row
// per external limit (not per tenant; the Groq quota is account-global).

export const rateLimiterBuckets = pgTable("rate_limiter_buckets", {
  key: text("key").primaryKey(),
  tokens: doublePrecision("tokens").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
