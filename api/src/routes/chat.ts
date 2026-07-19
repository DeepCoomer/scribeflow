import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { searchSegmentsByEmbedding } from "../db/repositories/retrieval.js";
import { startSse, sendSse } from "../lib/sse.js";
import { parseCorsOrigins } from "../lib/cors.js";

const chatSchema = z.object({ query: z.string().min(1).max(2000) });

// How many segments the answer is grounded in — enough context for a
// portfolio-scale meeting history without blowing the LLM's context window
// (same "keep it comfortably inside the window" reasoning as the
// extractor's TRANSCRIPT_CHAR_BUDGET, ticket 3.1).
const RETRIEVAL_LIMIT = 8;

const SYSTEM_PROMPT = `\
You answer questions about a team's past meetings using ONLY the numbered \
excerpts provided below — never outside knowledge. Cite the excerpt \
number(s) you drew on inline like [1] or [1][3]. If the excerpts don't \
contain the answer, say plainly that you couldn't find it in their \
meetings instead of guessing.`;

function formatTs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default async function chatRoutes(app: FastifyInstance) {
  // Ticket 3.6 (D64): SSE response to a POST, not an EventSource GET — a
  // free-text query doesn't fit safely/losslessly in a URL the way the
  // 1.6 events stream's short id path does, and consuming "text/event-
  // stream" only requires reading a fetch() ReadableStream, not the
  // EventSource API specifically.
  app.post("/chat", { preHandler: app.authenticate }, async (request, reply) => {
    const { query } = chatSchema.parse(request.body);
    const { tenantId } = request.auth!;

    if (!app.chat) {
      return reply.serviceUnavailable("chat is not configured");
    }

    const queryVector = await app.embedder.embed(query);
    const segments = await searchSegmentsByEmbedding(
      app.db,
      tenantId,
      queryVector,
      RETRIEVAL_LIMIT,
    );

    startSse(reply, request, parseCorsOrigins(app.config.CORS_ORIGINS));
    sendSse(
      reply,
      "citations",
      segments.map((s, i) => ({
        index: i + 1,
        meetingId: s.meetingId,
        meetingTitle: s.meetingTitle,
        segmentId: s.segmentId,
        startS: s.startS,
      })),
    );

    let clientClosed = false;
    request.raw.on("close", () => {
      clientClosed = true;
    });

    if (segments.length === 0) {
      sendSse(reply, "token", {
        text: "I couldn't find anything about that in your meetings yet.",
      });
      sendSse(reply, "done", {});
      reply.raw.end();
      return reply;
    }

    const context = segments
      .map(
        (s, i) =>
          `[${i + 1}] (${s.meetingTitle}, ${formatTs(s.startS)}) ${s.speaker ?? "Unknown"}: ${s.text}`,
      )
      .join("\n");
    const userPrompt = `Meeting excerpts:\n${context}\n\nQuestion: ${query}`;

    try {
      for await (const delta of app.chat.streamAnswer({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
      })) {
        if (clientClosed) break;
        sendSse(reply, "token", { text: delta });
      }
      if (!clientClosed) sendSse(reply, "done", {});
    } catch (err) {
      request.log.error(err, "chat stream failed");
      if (!clientClosed) sendSse(reply, "error", { message: "chat failed, try again" });
    }
    reply.raw.end();
    return reply;
  });
}
