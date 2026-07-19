import type { FastifyReply, FastifyRequest } from "fastify";

// Shared by the pipeline-status stream (1.6) and the RAG chat stream (3.6):
// both hijack the raw response to hand-roll SSE framing instead of a
// plugin, since neither is a plain Fastify JSON reply.

// reply.hijack() takes full control of the raw response, which means
// @fastify/cors's onSend hook never runs for this route (it only patches
// normal Fastify replies) — so the CORS header has to be set by hand here,
// mirroring the same allow-list app.ts hands to the cors plugin.
export function startSse(
  reply: FastifyReply,
  request: FastifyRequest,
  allowedOrigins: string[],
) {
  reply.hijack();
  const origin = request.headers.origin;
  const headers: Record<string, string> = {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["vary"] = "Origin";
  }
  reply.raw.writeHead(200, headers);
  reply.raw.write(":connected\n\n");
}

export function sendSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
