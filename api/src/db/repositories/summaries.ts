import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { meetingSummaries } from "../schema.js";

// Ticket 3.1: one row per meeting, upserted by the extractor worker. Null
// until the intelligence pass has run — the caller renders that as "not
// ready yet", not an error.
export async function getSummary(db: Db, tenantId: string, meetingId: string) {
  const [row] = await db
    .select()
    .from(meetingSummaries)
    .where(
      and(
        eq(meetingSummaries.tenantId, tenantId),
        eq(meetingSummaries.meetingId, meetingId),
      ),
    );
  return row ?? null;
}

// Ticket 3.4: recording the send is what makes the email approval-gated
// (CLAUDE.md) rather than automatic — this only ever runs from the explicit
// "send" endpoint, never from the extractor.
export async function markSummaryEmailSent(db: Db, tenantId: string, meetingId: string) {
  const rows = await db
    .update(meetingSummaries)
    .set({ emailSentAt: new Date() })
    .where(
      and(
        eq(meetingSummaries.tenantId, tenantId),
        eq(meetingSummaries.meetingId, meetingId),
      ),
    )
    .returning();
  return rows[0] ?? null;
}
