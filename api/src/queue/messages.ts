import { z } from "zod";

// Queue message schemas — the contract between the API and the Python
// workers (mirrored by pydantic models in workers/scribeflow_workers/
// messages.py). Snake_case on the wire because Python consumes them.
// Schema changes only ever add versioned fields, never mutate in place
// (CLAUDE.md conventions).

export const meetingUploadedV1 = z.object({
  v: z.literal(1),
  // q.slicer consumes two message shapes off the same queue (meeting.uploaded
  // and, ticket 5.3, meeting.finalize) — this discriminator is how
  // scribeflow_workers/slicer.py tells them apart, since the worker
  // framework's handler signature carries no routing key. Defaulted so a
  // sender that predates this field still parses.
  type: z.literal("meeting.uploaded").default("meeting.uploaded"),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  r2_key: z.string().min(1),
  duration_hint_s: z.number().positive().nullable(),
});

export type MeetingUploadedV1 = z.infer<typeof meetingUploadedV1>;

// Ticket 5.3, D69: published by the bot orchestrator once a bot session
// reaches a terminal state with >=1 segment uploaded.
export const meetingFinalizeV1 = z.object({
  v: z.literal(1),
  type: z.literal("meeting.finalize").default("meeting.finalize"),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
});

export type MeetingFinalizeV1 = z.infer<typeof meetingFinalizeV1>;

// Ticket 5.5: consumed by the bot orchestrator off q.bot_spawn, published by
// the API's "invite bot now" endpoint (Phase 6's scheduler will be a second
// publisher later). 30-min queue TTL + this requested_at both guard against
// a bot joining a meeting that already ended (D31).
export const botSpawnV1 = z.object({
  v: z.literal(1),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  meet_url: z.string().url(),
  display_name: z.string().min(1).nullable(),
  requested_at: z.string(),
});

export type BotSpawnV1 = z.infer<typeof botSpawnV1>;

// Published by workers to the `events` fanout exchange at every state
// transition; the API forwards them to SSE subscribers (ticket 1.6).
export const statusEventV1 = z.object({
  v: z.literal(1),
  type: z.literal("meeting.status"),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  status: z.enum([
    "pending",
    "uploading",
    "processing",
    "transcribing",
    "partial",
    "done",
    "failed",
  ]),
  error: z.string().nullable(),
  ts: z.string(),
});

export type StatusEventV1 = z.infer<typeof statusEventV1>;

// Published by the extractor worker (3.1/3.2, D59) once its job reaches a
// terminal state. Separate from statusEventV1 because extraction never
// changes meetings.status — a stitched transcript is already done/partial
// whether or not the intelligence pass has finished yet.
export const extractionEventV1 = z.object({
  v: z.literal(1),
  type: z.literal("meeting.extraction"),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  status: z.enum(["done", "failed"]),
  error: z.string().nullable(),
  ts: z.string(),
});

export type ExtractionEventV1 = z.infer<typeof extractionEventV1>;

// Published by the bot orchestrator (ticket 5.5) to the `events` fanout at
// every session state transition — a second event type for the same reason
// extractionEventV1 is separate from statusEventV1: a bot's lifecycle state
// isn't the meeting's pipeline status (meeting.status stays untouched until
// meeting.uploaded, docs/meet-bot.md).
export const botStatusEventV1 = z.object({
  v: z.literal(1),
  type: z.literal("bot.status"),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  session_id: z.string().uuid(),
  state: z.enum([
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
  ]),
  detail: z.string().nullable(),
  ts: z.string(),
});

export type BotStatusEventV1 = z.infer<typeof botStatusEventV1>;

export const pipelineEventV1 = z.discriminatedUnion("type", [
  statusEventV1,
  extractionEventV1,
  botStatusEventV1,
]);

export type PipelineEventV1 = z.infer<typeof pipelineEventV1>;
