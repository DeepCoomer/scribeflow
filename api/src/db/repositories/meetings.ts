import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { meetings } from "../schema.js";
import { firstOrThrow } from "../util.js";

export async function createMeeting(
  db: Db,
  tenantId: string,
  input: { title: string; startedAt?: Date | undefined },
) {
  const rows = await db
    .insert(meetings)
    .values({ tenantId, title: input.title, startedAt: input.startedAt ?? null })
    .returning();
  return firstOrThrow(rows, "meeting");
}

export async function findMeetingById(db: Db, tenantId: string, meetingId: string) {
  const [meeting] = await db
    .select()
    .from(meetings)
    .where(and(eq(meetings.tenantId, tenantId), eq(meetings.id, meetingId)));
  return meeting ?? null;
}

export async function listMeetings(db: Db, tenantId: string, limit = 50) {
  return db
    .select()
    .from(meetings)
    .where(eq(meetings.tenantId, tenantId))
    .orderBy(desc(meetings.createdAt))
    .limit(limit);
}

// Mint-time bookkeeping: the server-derived R2 key is recorded when the
// presigned URL is issued, so /uploaded can never be pointed at a key the
// API didn't choose (tenant prefix scoping, D20).
export async function markUploadStarted(
  db: Db,
  tenantId: string,
  meetingId: string,
  r2Key: string,
) {
  const rows = await db
    .update(meetings)
    .set({ r2Key, status: "uploading" })
    .where(and(eq(meetings.tenantId, tenantId), eq(meetings.id, meetingId)))
    .returning();
  return rows[0] ?? null;
}

export async function markUploaded(
  db: Db,
  tenantId: string,
  meetingId: string,
  durationHintS: number | null,
) {
  const rows = await db
    .update(meetings)
    .set({
      status: "processing",
      ...(durationHintS !== null ? { durationS: Math.round(durationHintS) } : {}),
    })
    .where(and(eq(meetings.tenantId, tenantId), eq(meetings.id, meetingId)))
    .returning();
  return rows[0] ?? null;
}
