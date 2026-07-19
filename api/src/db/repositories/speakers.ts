import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { meetings, meetingSpeakers } from "../schema.js";

// meeting_speakers carries no tenant_id column (mirrors transcript_segments,
// D56/D20), so tenant scoping happens via the join to meetings.
export async function listSpeakers(db: Db, tenantId: string, meetingId: string) {
  return db
    .select({
      speakerLabel: meetingSpeakers.speakerLabel,
      displayName: meetingSpeakers.displayName,
      userId: meetingSpeakers.userId,
      source: meetingSpeakers.source,
    })
    .from(meetingSpeakers)
    .innerJoin(meetings, eq(meetingSpeakers.meetingId, meetings.id))
    .where(and(eq(meetings.tenantId, tenantId), eq(meetings.id, meetingId)));
}

// Renaming is a one-row update (D56) — the stitcher's ON CONFLICT DO
// NOTHING seed is what created the row this targets; a label that never
// appeared in speaker_turns has no row to rename, hence the null return.
export async function renameSpeaker(
  db: Db,
  tenantId: string,
  meetingId: string,
  speakerLabel: string,
  input: { displayName: string; userId?: string | null | undefined },
) {
  const [meeting] = await db
    .select({ id: meetings.id })
    .from(meetings)
    .where(and(eq(meetings.tenantId, tenantId), eq(meetings.id, meetingId)));
  if (!meeting) return null;

  const rows = await db
    .update(meetingSpeakers)
    .set({
      displayName: input.displayName,
      userId: input.userId ?? null,
      source: "user",
    })
    .where(
      and(
        eq(meetingSpeakers.meetingId, meetingId),
        eq(meetingSpeakers.speakerLabel, speakerLabel),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
