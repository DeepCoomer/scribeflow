import { sql } from "drizzle-orm";
import type { Db } from "../client.js";

// Ticket 3.6 (D64): retrieval for the "ask your meetings" RAG chat. Raw SQL
// (not the query builder) because pgvector's `<=>` cosine-distance operator
// and the `::vector` cast on a query embedding aren't expressible through
// drizzle-orm's builder — the same reasoning schema.ts gives for hand-adding
// the HNSW index instead of declaring it there. tenantId scopes via the join
// to meetings (D20 — transcript_segments carries no tenant_id column,
// same as listSegments in segments.ts) — a mismatched tenant simply
// retrieves nothing, never another tenant's rows.

export type RetrievedSegment = {
  segmentId: string;
  meetingId: string;
  meetingTitle: string;
  speaker: string | null;
  startS: number;
  text: string;
  similarity: number;
};

function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}

export async function searchSegmentsByEmbedding(
  db: Db,
  tenantId: string,
  queryVector: number[],
  limit: number,
): Promise<RetrievedSegment[]> {
  const vectorLiteral = toVectorLiteral(queryVector);
  const result = await db.execute<{
    segmentId: string;
    meetingId: string;
    meetingTitle: string;
    speaker: string | null;
    startS: string;
    text: string;
    similarity: number;
  }>(sql`
    SELECT
      ts.id AS "segmentId",
      ts.meeting_id AS "meetingId",
      m.title AS "meetingTitle",
      ts.speaker AS "speaker",
      ts.start_s AS "startS",
      ts.text AS "text",
      1 - (ts.embedding <=> ${vectorLiteral}::vector) AS "similarity"
    FROM transcript_segments ts
    JOIN meetings m ON m.id = ts.meeting_id
    WHERE m.tenant_id = ${tenantId}
      AND ts.embedding IS NOT NULL
    ORDER BY ts.embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `);
  return Array.from(result).map((row) => ({
    segmentId: row.segmentId,
    meetingId: row.meetingId,
    meetingTitle: row.meetingTitle,
    speaker: row.speaker,
    startS: Number(row.startS),
    text: row.text,
    similarity: Number(row.similarity),
  }));
}
