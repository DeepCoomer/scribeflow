import { z } from "zod";

// Queue message schemas — the contract between the API and the Python
// workers (mirrored by pydantic models in workers/scribeflow_workers/
// messages.py). Snake_case on the wire because Python consumes them.
// Schema changes only ever add versioned fields, never mutate in place
// (CLAUDE.md conventions).

export const meetingUploadedV1 = z.object({
  v: z.literal(1),
  tenant_id: z.string().uuid(),
  meeting_id: z.string().uuid(),
  r2_key: z.string().min(1),
  duration_hint_s: z.number().positive().nullable(),
});

export type MeetingUploadedV1 = z.infer<typeof meetingUploadedV1>;

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

export const pipelineEventV1 = z.discriminatedUnion("type", [
  statusEventV1,
  extractionEventV1,
]);

export type PipelineEventV1 = z.infer<typeof pipelineEventV1>;
