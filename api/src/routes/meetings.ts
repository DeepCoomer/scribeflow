import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../types/fastify.js";
import {
  createMeeting,
  findMeetingById,
  listMeetings,
  markUploadStarted,
  markUploaded,
} from "../db/repositories/meetings.js";
import { listSegments } from "../db/repositories/segments.js";
import { listSpeakers, renameSpeaker } from "../db/repositories/speakers.js";
import { findUserById } from "../db/repositories/users.js";
import { ROUTING_KEYS } from "../queue/topology.js";
import type { MeetingUploadedV1, StatusEventV1 } from "../queue/messages.js";
import { parseCorsOrigins } from "../lib/cors.js";

const MAX_UPLOAD_BYTES = 500 * 1024 * 1024; // architecture.md data-flow cap

// The set Groq Whisper accepts — rejecting anything else here beats a
// worker-side failure three retries later.
const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

const createSchema = z.object({
  title: z.string().min(1).max(300),
  startedAt: z.coerce.date().optional(),
});

const uploadUrlSchema = z.object({
  contentType: z.string(),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
});

const uploadedSchema = z.object({
  durationHintS: z.number().positive().nullable().default(null),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const speakerParamSchema = z.object({ id: z.string().uuid(), label: z.string().min(1) });

const renameSpeakerSchema = z.object({
  displayName: z.string().min(1).max(100),
  userId: z.string().uuid().nullable().optional(),
});

function meetingView(m: NonNullable<Awaited<ReturnType<typeof findMeetingById>>>) {
  return {
    id: m.id,
    title: m.title,
    status: m.status,
    startedAt: m.startedAt,
    durationS: m.durationS,
    error: m.error,
    createdAt: m.createdAt,
  };
}

export default async function meetingRoutes(app: FastifyInstance) {
  const protectedOpts = { preHandler: app.authenticate };

  app.post("/meetings", protectedOpts, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { tenantId } = request.auth!;
    const meeting = await createMeeting(app.db, tenantId, body);
    return reply.code(201).send(meetingView(meeting));
  });

  app.get("/meetings", protectedOpts, async (request) => {
    const { tenantId } = request.auth!;
    const rows = await listMeetings(app.db, tenantId);
    return { meetings: rows.map(meetingView) };
  });

  app.get("/meetings/:id", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { tenantId } = request.auth!;
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    return meetingView(meeting);
  });

  // Ticket 1.1 — the API mints a URL and steps aside (D7): the client PUTs
  // the bytes straight to R2. Key is server-derived and tenant-prefixed;
  // content type and size are baked into the signature.
  app.post("/meetings/:id/upload-url", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = uploadUrlSchema.parse(request.body);
    const { tenantId } = request.auth!;

    if (!app.r2) {
      return reply.serviceUnavailable("object storage is not configured");
    }
    const ext = AUDIO_EXTENSIONS[body.contentType];
    if (!ext) {
      return reply.unsupportedMediaType(
        `contentType must be one of: ${Object.keys(AUDIO_EXTENSIONS).join(", ")}`,
      );
    }

    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    if (meeting.status !== "pending" && meeting.status !== "uploading") {
      return reply.conflict(`meeting is already ${meeting.status}`);
    }

    const key = `tenant/${tenantId}/meeting/${id}/audio.${ext}`;
    const url = await app.r2.presignPut({
      key,
      contentType: body.contentType,
      contentLength: body.sizeBytes,
      expiresInS: app.config.UPLOAD_URL_TTL_S,
    });
    await markUploadStarted(app.db, tenantId, id, key);

    return { url, key, expiresInS: app.config.UPLOAD_URL_TTL_S };
  });

  // Ticket 1.1 — upload completion: enqueue meeting.uploaded, then flip to
  // processing. Publish comes first: a "processing" meeting with no queued
  // job would hang forever, while the reverse (job queued, status update
  // lost) self-heals when the worker writes its own transitions.
  app.post("/meetings/:id/uploaded", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = uploadedSchema.parse(request.body ?? {});
    const { tenantId } = request.auth!;

    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    if (!meeting.r2Key || meeting.status === "pending") {
      return reply.conflict("request an upload URL before marking uploaded");
    }
    if (meeting.status !== "uploading") {
      // Idempotent for client retries: already enqueued once, don't again.
      return meetingView(meeting);
    }

    const message: MeetingUploadedV1 = {
      v: 1,
      tenant_id: tenantId,
      meeting_id: id,
      r2_key: meeting.r2Key,
      duration_hint_s: body.durationHintS,
    };

    try {
      await app.queue.publish(ROUTING_KEYS.meetingUploaded, message);
    } catch (err) {
      request.log.error(err, "failed to enqueue meeting.uploaded");
      return reply.serviceUnavailable("queue unavailable, retry shortly");
    }
    const updated = await markUploaded(app.db, tenantId, id, body.durationHintS);
    return meetingView(updated ?? meeting);
  });

  app.get("/meetings/:id/transcript", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { tenantId } = request.auth!;
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    const [segments, speakers] = await Promise.all([
      listSegments(app.db, tenantId, id),
      listSpeakers(app.db, tenantId, id),
    ]);
    return { meeting: meetingView(meeting), segments, speakers };
  });

  // Ticket 2.6 (D56): rename a diarized speaker for this meeting. Calendar
  // attendees are a candidate list for this input (Phase 6), never an
  // auto-assignment — the stitcher only ever seeds a "Speaker N" default.
  app.patch("/meetings/:id/speakers/:label", protectedOpts, async (request, reply) => {
    const { id, label } = speakerParamSchema.parse(request.params);
    const body = renameSpeakerSchema.parse(request.body);
    const { tenantId } = request.auth!;

    // D20: userId is caller-supplied, so it must be checked against the
    // caller's own tenant before it's allowed to land on another tenant's
    // meeting_speakers row — otherwise any authenticated user could link an
    // arbitrary user id (from any tenant) into someone else's meeting.
    if (body.userId) {
      const owner = await findUserById(app.db, tenantId, body.userId);
      if (!owner) return reply.badRequest("userId does not belong to this tenant");
    }

    const updated = await renameSpeaker(app.db, tenantId, id, label, {
      displayName: body.displayName,
      userId: body.userId,
    });
    if (!updated) return reply.notFound();
    return {
      speakerLabel: updated.speakerLabel,
      displayName: updated.displayName,
      userId: updated.userId,
      source: updated.source,
    };
  });

  // Ticket 1.6 — live job status over SSE. EventSource cannot set an
  // Authorization header, so the JWT arrives as ?token= (D44); it's verified
  // with the same secret and the stream is scoped to the token's tenant.
  app.get("/meetings/:id/events", async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { token } = z.object({ token: z.string().min(1) }).parse(request.query);

    let auth: AuthContext;
    try {
      auth = app.jwt.verify<AuthContext>(token);
    } catch {
      return reply.unauthorized("Missing or invalid token");
    }

    const meeting = await findMeetingById(app.db, auth.tenantId, id);
    if (!meeting) return reply.notFound();

    startSse(reply, request, parseCorsOrigins(app.config.CORS_ORIGINS));
    // Snapshot first so a client that connects after a transition doesn't
    // wait on an event that already happened.
    sendSse(reply, "status", {
      meeting_id: meeting.id,
      status: meeting.status,
      error: meeting.error,
    });

    const unsubscribe = app.events.subscribe(auth.tenantId, (event: StatusEventV1) => {
      if (event.meeting_id !== id) return;
      sendSse(reply, "status", {
        meeting_id: event.meeting_id,
        status: event.status,
        error: event.error,
      });
    });

    // Comment heartbeat keeps proxies (Caddy) from idling the socket out.
    const heartbeat = setInterval(() => reply.raw.write(":hb\n\n"), 15_000);
    request.raw.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      reply.raw.end();
    });
    return reply;
  });
}

// reply.hijack() takes full control of the raw response, which means
// @fastify/cors's onSend hook never runs for this route (it only patches
// normal Fastify replies) — so the CORS header has to be set by hand here,
// mirroring the same allow-list app.ts hands to the cors plugin.
function startSse(
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

function sendSse(reply: FastifyReply, event: string, data: unknown) {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
