import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { meetingFollowups } from "../schema.js";

// Ticket 3.7 (D65): the last-sent follow-up, if any — the caller uses this
// to prefill the editable draft with what actually went out last time,
// falling back to a freshly composed default (lib/followup.ts) when nothing
// has ever been sent for this meeting.
export async function getLastFollowup(db: Db, tenantId: string, meetingId: string) {
  const [row] = await db
    .select()
    .from(meetingFollowups)
    .where(
      and(
        eq(meetingFollowups.tenantId, tenantId),
        eq(meetingFollowups.meetingId, meetingId),
      ),
    );
  return row ?? null;
}

// Upserted by meeting_id (mirrors meeting_summaries): a resend overwrites
// the prior record rather than accumulating a history table nobody reads.
export async function recordFollowupSent(
  db: Db,
  tenantId: string,
  meetingId: string,
  body: string,
) {
  const [row] = await db
    .insert(meetingFollowups)
    .values({ tenantId, meetingId, body, sentAt: new Date() })
    .onConflictDoUpdate({
      target: meetingFollowups.meetingId,
      set: { body, sentAt: new Date() },
    })
    .returning();
  return row!;
}
