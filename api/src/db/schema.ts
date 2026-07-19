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
} from "drizzle-orm/pg-core";

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
    ownerUserId: uuid("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dueDate: timestamp("due_date", { withTimezone: true }),
    // 0..1 LLM extraction confidence; drives review-queue triage later.
    confidence: numeric("confidence", { precision: 3, scale: 2 }),
    status: actionItemStatusEnum("status").notNull().default("open"),
    // Points at a transcript_segments row once Phase 1 lands; no FK yet
    // because that table doesn't exist in this migration.
    sourceSegmentId: uuid("source_segment_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
// file. Ticket 2.6 reads this alongside transcript_segments to assign a
// speaker to each segment by maximum temporal overlap (D13); nothing reads
// speaker_turns directly before that merge runs.

export const speakerTurns = pgTable("speaker_turns", {
  id: uuid("id").primaryKey().defaultRandom(),
  meetingId: uuid("meeting_id")
    .notNull()
    .references(() => meetings.id, { onDelete: "cascade" }),
  speakerLabel: text("speaker_label").notNull(),
  startS: doublePrecision("start_s").notNull(),
  endS: doublePrecision("end_s").notNull(),
});

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
