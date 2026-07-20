import { z } from "zod";

// Wire contracts the orchestrator speaks — mirrors the relevant subset of
// api/src/queue/messages.ts exactly (same field names/types on the wire).
// bot/ is its own pnpm package with no dependency on api/, so this is a
// second, independent mirror, same relationship workers/scribeflow_workers/
// topology.py already has with api/src/queue/topology.ts: keep both in sync
// in the same commit.

export const botSpawnV1 = z.object({
  v: z.literal(1),
  tenant_id: z.string().min(1),
  meeting_id: z.string().min(1),
  meet_url: z.string().url(),
  display_name: z.string().min(1).nullable(),
  requested_at: z.string(),
});

export type BotSpawnV1 = z.infer<typeof botSpawnV1>;

export const meetingFinalizeV1 = z.object({
  v: z.literal(1),
  type: z.literal("meeting.finalize"),
  tenant_id: z.string(),
  meeting_id: z.string(),
});

export type MeetingFinalizeV1 = z.infer<typeof meetingFinalizeV1>;

export function buildMeetingFinalizeV1(
  tenantId: string,
  meetingId: string,
): MeetingFinalizeV1 {
  return { v: 1, type: "meeting.finalize", tenant_id: tenantId, meeting_id: meetingId };
}

export const BOT_STATES = [
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
] as const;

export type BotSessionState = (typeof BOT_STATES)[number];

const TERMINAL_STATES: ReadonlySet<BotSessionState> = new Set([
  "done",
  "not_admitted",
  "denied",
  "blocked",
  "invalid_url",
  "failed",
]);

export function isTerminal(state: BotSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

export type BotStatusEventV1 = {
  v: 1;
  type: "bot.status";
  tenant_id: string;
  meeting_id: string;
  session_id: string;
  state: BotSessionState;
  detail: string | null;
  ts: string;
};

export function buildBotStatusEventV1(fields: {
  tenantId: string;
  meetingId: string;
  sessionId: string;
  state: BotSessionState;
  detail?: string | null;
}): BotStatusEventV1 {
  return {
    v: 1,
    type: "bot.status",
    tenant_id: fields.tenantId,
    meeting_id: fields.meetingId,
    session_id: fields.sessionId,
    state: fields.state,
    detail: fields.detail ?? null,
    ts: new Date().toISOString(),
  };
}
