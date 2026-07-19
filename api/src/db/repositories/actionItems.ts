import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { actionItems, meetings } from "../schema.js";

// Ticket 3.3: the tenant-wide action-items dashboard, newest meeting first.
// action_items carries tenant_id directly (unlike transcript_segments), so
// this filters on it rather than joining through meetings for scoping (D20
// still holds — tenantId is a required parameter either way); the join here
// is only to surface the meeting's title for the list UI.
export async function listActionItems(db: Db, tenantId: string) {
  return db
    .select({
      id: actionItems.id,
      meetingId: actionItems.meetingId,
      meetingTitle: meetings.title,
      text: actionItems.text,
      ownerName: actionItems.ownerName,
      ownerUserId: actionItems.ownerUserId,
      dueDate: actionItems.dueDate,
      confidence: actionItems.confidence,
      status: actionItems.status,
      sourceSegmentId: actionItems.sourceSegmentId,
      createdAt: actionItems.createdAt,
    })
    .from(actionItems)
    .innerJoin(meetings, eq(actionItems.meetingId, meetings.id))
    .where(eq(actionItems.tenantId, tenantId))
    .orderBy(desc(actionItems.createdAt));
}

export async function listActionItemsForMeeting(
  db: Db,
  tenantId: string,
  meetingId: string,
) {
  return db
    .select()
    .from(actionItems)
    .where(and(eq(actionItems.tenantId, tenantId), eq(actionItems.meetingId, meetingId)))
    .orderBy(desc(actionItems.createdAt));
}

// Ticket 3.3's "assign"/"mark done": a human can set the real owner (a
// tenant user, verified by the caller before this is called — same D20
// cross-tenant caution as the 2.6 speaker-rename endpoint) and/or the
// status; the LLM-extracted ownerName/dueDate/confidence stay untouched.
export async function updateActionItem(
  db: Db,
  tenantId: string,
  meetingId: string,
  itemId: string,
  input: {
    status?: "open" | "done" | "dismissed" | undefined;
    ownerUserId?: string | null | undefined;
    dueDate?: Date | null | undefined;
  },
) {
  const scope = and(
    eq(actionItems.tenantId, tenantId),
    eq(actionItems.meetingId, meetingId),
    eq(actionItems.id, itemId),
  );
  const patch: Record<string, unknown> = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.ownerUserId !== undefined) patch.ownerUserId = input.ownerUserId;
  if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
  if (Object.keys(patch).length === 0) {
    const [existing] = await db.select().from(actionItems).where(scope);
    return existing ?? null;
  }

  const rows = await db.update(actionItems).set(patch).where(scope).returning();
  return rows[0] ?? null;
}
