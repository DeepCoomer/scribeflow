import postgres from "postgres";
import { isTerminal, type BotSessionState } from "./messages.js";

// bot_sessions repository — raw SQL (postgres-js), same house style as
// workers/scribeflow_workers/db.py: every function takes tenantId and scopes
// its WHERE clause with it (invariant 2), no bypass helpers.

export type Sql = ReturnType<typeof postgres>;

export function connect(databaseUrl: string): Sql {
  return postgres(databaseUrl, { max: 5 });
}

export type BotSessionRow = {
  id: string;
  tenantId: string;
  meetingId: string;
  jobKey: string;
  meetUrl: string;
  containerId: string | null;
  state: BotSessionState;
  sessionToken: string;
  segmentsUploaded: number;
  rejoined: boolean;
};

function mapRow(row: Record<string, unknown>): BotSessionRow {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    meetingId: row.meeting_id as string,
    jobKey: row.job_key as string,
    meetUrl: row.meet_url as string,
    containerId: (row.container_id as string | null) ?? null,
    state: row.state as BotSessionState,
    sessionToken: row.session_token as string,
    segmentsUploaded: Number(row.segments_uploaded),
    rejoined: Boolean(row.rejoined),
  };
}

/** Non-terminal = anything but the six terminal outcomes (bot/src/state.ts). */
const TERMINAL_STATES_LIST = [
  "done",
  "not_admitted",
  "denied",
  "blocked",
  "invalid_url",
  "failed",
];

export async function findNonTerminalSessionForMeeting(
  sql: Sql,
  meetingId: string,
): Promise<BotSessionRow | null> {
  const rows = await sql`
    SELECT * FROM bot_sessions
    WHERE meeting_id = ${meetingId} AND state NOT IN ${sql(TERMINAL_STATES_LIST)}
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function createSession(
  sql: Sql,
  fields: {
    tenantId: string;
    meetingId: string;
    jobKey: string;
    meetUrl: string;
    sessionToken: string;
  },
): Promise<BotSessionRow> {
  const rows = await sql`
    INSERT INTO bot_sessions (tenant_id, meeting_id, job_key, meet_url, session_token, state)
    VALUES (${fields.tenantId}, ${fields.meetingId}, ${fields.jobKey}, ${fields.meetUrl}, ${fields.sessionToken}, 'spawning')
    RETURNING *
  `;
  return mapRow(rows[0]!);
}

export async function findSessionById(
  sql: Sql,
  id: string,
): Promise<BotSessionRow | null> {
  const rows = await sql`SELECT * FROM bot_sessions WHERE id = ${id}`;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function setContainerId(
  sql: Sql,
  id: string,
  containerId: string,
): Promise<void> {
  await sql`UPDATE bot_sessions SET container_id = ${containerId} WHERE id = ${id}`;
}

export async function recordHeartbeat(
  sql: Sql,
  id: string,
  state: BotSessionState,
): Promise<void> {
  await sql`
    UPDATE bot_sessions SET state = ${state}, last_heartbeat_at = now() WHERE id = ${id}
  `;
}

export async function recordEvent(
  sql: Sql,
  id: string,
  state: BotSessionState,
  detail: string | null,
): Promise<void> {
  const terminal = isTerminal(state);
  const isRecording = state === "recording";
  const isFailureTerminal = terminal && state !== "done";
  await sql`
    UPDATE bot_sessions
    SET state = ${state},
        outcome_detail = ${detail},
        last_heartbeat_at = now(),
        joined_at = CASE WHEN ${isRecording} AND joined_at IS NULL THEN now() ELSE joined_at END,
        left_at = CASE WHEN ${terminal} AND left_at IS NULL THEN now() ELSE left_at END,
        error = CASE WHEN ${isFailureTerminal} THEN ${detail} ELSE error END
    WHERE id = ${id}
  `;
}

export async function incrementSegmentsUploaded(sql: Sql, id: string): Promise<void> {
  await sql`UPDATE bot_sessions SET segments_uploaded = segments_uploaded + 1 WHERE id = ${id}`;
}

export async function markRejoined(
  sql: Sql,
  id: string,
  containerId: string,
): Promise<void> {
  await sql`
    UPDATE bot_sessions
    SET rejoined = true, container_id = ${containerId}, state = 'joining', last_heartbeat_at = now()
    WHERE id = ${id}
  `;
}

/** Sessions the reaper needs to look at: non-terminal and either never
 * heartbeated or silent past the timeout. */
export async function listStaleNonTerminal(
  sql: Sql,
  heartbeatTimeoutS: number,
): Promise<BotSessionRow[]> {
  const rows = await sql`
    SELECT * FROM bot_sessions
    WHERE state NOT IN ${sql(TERMINAL_STATES_LIST)}
      AND (last_heartbeat_at IS NULL OR last_heartbeat_at < now() - (${heartbeatTimeoutS}::text || ' seconds')::interval)
      AND created_at < now() - (${heartbeatTimeoutS}::text || ' seconds')::interval
  `;
  return rows.map(mapRow);
}

// -- Db interface -------------------------------------------------------------
// spawn.ts/reaper.ts/controlPlaneServer.ts depend on this narrow interface
// rather than importing the module directly, so tests can supply an
// in-memory fake instead of a real Postgres (same "fake docker client"
// testing shape docs/meet-bot.md calls for, applied to the DB side too).

export type Db = {
  findNonTerminalSessionForMeeting(meetingId: string): Promise<BotSessionRow | null>;
  createSession(fields: {
    tenantId: string;
    meetingId: string;
    jobKey: string;
    meetUrl: string;
    sessionToken: string;
  }): Promise<BotSessionRow>;
  findSessionById(id: string): Promise<BotSessionRow | null>;
  setContainerId(id: string, containerId: string): Promise<void>;
  recordHeartbeat(id: string, state: BotSessionState): Promise<void>;
  recordEvent(id: string, state: BotSessionState, detail: string | null): Promise<void>;
  incrementSegmentsUploaded(id: string): Promise<void>;
  markRejoined(id: string, containerId: string): Promise<void>;
  listStaleNonTerminal(heartbeatTimeoutS: number): Promise<BotSessionRow[]>;
};

export function createDb(sql: Sql): Db {
  return {
    findNonTerminalSessionForMeeting: (meetingId) =>
      findNonTerminalSessionForMeeting(sql, meetingId),
    createSession: (fields) => createSession(sql, fields),
    findSessionById: (id) => findSessionById(sql, id),
    setContainerId: (id, containerId) => setContainerId(sql, id, containerId),
    recordHeartbeat: (id, state) => recordHeartbeat(sql, id, state),
    recordEvent: (id, state, detail) => recordEvent(sql, id, state, detail),
    incrementSegmentsUploaded: (id) => incrementSegmentsUploaded(sql, id),
    markRejoined: (id, containerId) => markRejoined(sql, id, containerId),
    listStaleNonTerminal: (heartbeatTimeoutS) =>
      listStaleNonTerminal(sql, heartbeatTimeoutS),
  };
}
