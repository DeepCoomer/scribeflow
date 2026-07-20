import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { BotSessionRow, Db } from "./db.js";
import type { R2 } from "./r2.js";
import { botSegmentKey, botDebugKey } from "./r2.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { OrchestratorQueue } from "./queue.js";
import { BOT_STATES, isTerminal } from "./messages.js";
import type { Env } from "./config.js";
import { getLogger } from "../logging.js";

const log = getLogger("orchestrator.controlPlane");

const stateSchema = z.enum(BOT_STATES);

const heartbeatSchema = z.object({
  state: stateSchema,
  participantCount: z.number().int().nonnegative().optional(),
  rmsHealthy: z.boolean().optional(),
});

const eventSchema = z.object({
  state: stateSchema,
  detail: z.string().nullable().optional(),
});

const segmentUrlSchema = z.object({
  idx: z.number().int().nonnegative(),
  startedAtMs: z.number().int().nonnegative(),
});

const debugUrlSchema = z.object({ name: z.string().min(1).max(200) });

export type ControlPlaneDeps = {
  db: Db;
  r2: R2 | null;
  sessionRegistry: SessionRegistry;
  queue: OrchestratorQueue;
  env: Env;
};

// HTTP control plane (ticket 5.5, D70): the bot container gets only its
// BOT_CONFIG + a random per-session token, calling back here for every
// infra-touching operation. This process owns R2/Postgres/RabbitMQ; the bot
// never sees a credential for any of them.
export function createControlPlaneServer(deps: ControlPlaneDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook("preHandler", async (request, reply) => {
    const { id } = request.params as { id?: string };
    if (!id) return;
    const auth = request.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
    const session = await deps.db.findSessionById(id);
    if (!session || !token || session.sessionToken !== token) {
      return reply.code(401).send({ error: "invalid session or token" });
    }
    (request as unknown as { session: BotSessionRow }).session = session;
  });

  app.post("/sessions/:id/heartbeat", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = heartbeatSchema.parse(request.body);
    await deps.db.recordHeartbeat(id, body.state);
    return reply.code(204).send();
  });

  app.post("/sessions/:id/event", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = (request as unknown as { session: BotSessionRow }).session;
    const body = eventSchema.parse(request.body);
    await deps.db.recordEvent(id, body.state, body.detail ?? null);
    await deps.queue
      .publishBotStatus({
        tenantId: session.tenantId,
        meetingId: session.meetingId,
        sessionId: id,
        state: body.state,
        detail: body.detail ?? null,
      })
      .catch((err: unknown) =>
        log.warn("publish_bot_status_failed", { error: String(err) }),
      );

    if (isTerminal(body.state)) {
      deps.sessionRegistry.resolveTerminal(id);
      const fresh = await deps.db.findSessionById(id);
      if (fresh && fresh.segmentsUploaded > 0) {
        await deps.queue
          .publishFinalize(fresh.tenantId, fresh.meetingId)
          .catch((err: unknown) =>
            log.error("publish_finalize_failed", { error: String(err) }),
          );
      }
    }
    return reply.code(204).send();
  });

  app.post("/sessions/:id/segment-url", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = (request as unknown as { session: BotSessionRow }).session;
    const body = segmentUrlSchema.parse(request.body);
    if (!deps.r2)
      return reply.code(503).send({ error: "object storage is not configured" });

    const key = botSegmentKey(
      session.tenantId,
      session.meetingId,
      body.idx,
      body.startedAtMs,
    );
    const url = await deps.r2.presignPut(key, "audio/ogg", deps.env.UPLOAD_URL_TTL_S);
    await deps.db.incrementSegmentsUploaded(id);
    return { url, key };
  });

  app.post("/sessions/:id/debug-url", async (request, reply) => {
    const session = (request as unknown as { session: BotSessionRow }).session;
    const body = debugUrlSchema.parse(request.body);
    if (!deps.r2)
      return reply.code(503).send({ error: "object storage is not configured" });

    const key = botDebugKey(session.tenantId, session.meetingId, body.name);
    const url = await deps.r2.presignPut(key, "image/png", deps.env.UPLOAD_URL_TTL_S);
    return { url, key };
  });

  return app;
}
