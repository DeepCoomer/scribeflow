import "dotenv/config";
import { z } from "zod";

// Bot runtime configuration (ticket 5.2, config table in docs/meet-bot.md).
// Two layers: process-wide defaults (env vars, same across every bot
// container) and the per-session BOT_CONFIG blob the orchestrator injects at
// spawn time (D70) — "meeting id, Meet URL, display name, session token" per
// the spec, extended here with sessionId/orchestratorUrl/platform so the
// control-plane client and platform strategy have what they need without a
// second env var (smallest compliant extension of the documented shape).

const envSchema = z.object({
  BOT_ADMISSION_TIMEOUT_S: z.coerce.number().int().positive().default(300),
  BOT_JOIN_REQUEST_ATTEMPTS: z.coerce.number().int().positive().default(3),
  BOT_LONE_PARTICIPANT_S: z.coerce.number().int().positive().default(60),
  BOT_NO_ONE_JOINED_S: z.coerce.number().int().positive().default(600),
  BOT_MAX_DURATION_S: z.coerce.number().int().positive().default(7200),
  BOT_SEGMENT_S: z.coerce.number().int().positive().default(300),
  BOT_DISPLAY_NAME: z.string().min(1).default("ScribeFlow Notetaker"),
  BOT_DEBUG_VNC: z.coerce.boolean().default(false),
  BOT_STORAGE_STATE_PATH: z.string().optional(),
  BOT_RECORDING_DIR: z.string().default("/rec"),
  BOT_CONFIG: z.string().min(1),
});

const sessionConfigSchema = z.object({
  tenantId: z.string().min(1),
  meetingId: z.string().min(1),
  sessionId: z.string().min(1),
  sessionToken: z.string().min(1),
  meetUrl: z.string().url(),
  displayName: z.string().min(1).optional(),
  orchestratorUrl: z.string().url(),
  platform: z.enum(["meet", "zoom"]).default("meet"),
});

export type SessionConfig = z.infer<typeof sessionConfigSchema>;

export type Settings = {
  admissionTimeoutS: number;
  joinRequestAttempts: number;
  loneParticipantS: number;
  noOneJoinedS: number;
  maxDurationS: number;
  segmentS: number;
  displayName: string;
  debugVnc: boolean;
  storageStatePath: string | undefined;
  recordingDir: string;
  session: SessionConfig;
};

export function loadSettings(source: NodeJS.ProcessEnv = process.env): Settings {
  const env = envSchema.parse(source);
  let sessionRaw: unknown;
  try {
    sessionRaw = JSON.parse(env.BOT_CONFIG);
  } catch (err) {
    throw new Error(`BOT_CONFIG is not valid JSON: ${String(err)}`);
  }
  const session = sessionConfigSchema.parse(sessionRaw);
  return {
    admissionTimeoutS: env.BOT_ADMISSION_TIMEOUT_S,
    joinRequestAttempts: env.BOT_JOIN_REQUEST_ATTEMPTS,
    loneParticipantS: env.BOT_LONE_PARTICIPANT_S,
    noOneJoinedS: env.BOT_NO_ONE_JOINED_S,
    maxDurationS: env.BOT_MAX_DURATION_S,
    segmentS: env.BOT_SEGMENT_S,
    displayName: session.displayName ?? env.BOT_DISPLAY_NAME,
    debugVnc: env.BOT_DEBUG_VNC,
    storageStatePath: env.BOT_STORAGE_STATE_PATH,
    recordingDir: env.BOT_RECORDING_DIR,
    session,
  };
}
