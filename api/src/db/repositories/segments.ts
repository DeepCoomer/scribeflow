import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { meetings, transcriptSegments } from "../schema.js";

// transcript_segments carries no tenant_id column (architecture.md schema),
// so tenant scoping happens via the join to meetings — the tenantId
// requirement (D20) holds at this function boundary like everywhere else.
export async function listSegments(db: Db, tenantId: string, meetingId: string) {
  return db
    .select({
      id: transcriptSegments.id,
      chunkIdx: transcriptSegments.chunkIdx,
      speaker: transcriptSegments.speaker,
      startS: transcriptSegments.startS,
      endS: transcriptSegments.endS,
      text: transcriptSegments.text,
      // Ticket 3.2: null until the extractor's batched sentiment pass runs.
      sentimentLabel: transcriptSegments.sentimentLabel,
      sentimentScore: transcriptSegments.sentimentScore,
    })
    .from(transcriptSegments)
    .innerJoin(meetings, eq(transcriptSegments.meetingId, meetings.id))
    .where(and(eq(meetings.tenantId, tenantId), eq(meetings.id, meetingId)))
    .orderBy(asc(transcriptSegments.startS));
}
