import { z } from "zod";
import type { FastifyInstance } from "fastify";
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
import {
  listActionItems,
  listActionItemsForMeeting,
  updateActionItem,
} from "../db/repositories/actionItems.js";
import { getSummary, markSummaryEmailSent } from "../db/repositories/summaries.js";
import { getLastFollowup, recordFollowupSent } from "../db/repositories/followups.js";
import { composeDefaultFollowup } from "../lib/followup.js";
import { ROUTING_KEYS } from "../queue/topology.js";
import type {
  BotSpawnV1,
  MeetingUploadedV1,
  PipelineEventV1,
} from "../queue/messages.js";
import { parseCorsOrigins } from "../lib/cors.js";
import { startSse, sendSse } from "../lib/sse.js";

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

const inviteBotSchema = z.object({
  meetUrl: z.string().url().optional(),
  displayName: z.string().min(1).max(100).optional(),
});

const followupSendSchema = z.object({ body: z.string().min(1).max(20_000) });

const actionItemParamSchema = z.object({
  id: z.string().uuid(),
  itemId: z.string().uuid(),
});

// Ticket 3.3: "assign, mark done" — the LLM-extracted text/ownerName/
// confidence are read-only from here; only the human-editable fields are
// patchable.
const updateActionItemSchema = z.object({
  status: z.enum(["open", "done", "dismissed"]).optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  dueDate: z.coerce.date().nullable().optional(),
});

function actionItemView(item: {
  id: string;
  meetingId: string;
  text: string;
  ownerName: string | null;
  ownerUserId: string | null;
  dueDate: Date | null;
  confidence: string | null;
  status: string;
  sourceSegmentId: string | null;
  createdAt: Date;
}) {
  return {
    id: item.id,
    meetingId: item.meetingId,
    text: item.text,
    ownerName: item.ownerName,
    ownerUserId: item.ownerUserId,
    dueDate: item.dueDate,
    confidence: item.confidence === null ? null : Number(item.confidence),
    status: item.status,
    sourceSegmentId: item.sourceSegmentId,
    createdAt: item.createdAt,
  };
}

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
      type: "meeting.uploaded",
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

  // Ticket 5.5 — "invite bot now": publishes bot.spawn for the orchestrator
  // to pick up off q.bot_spawn. Meeting status is untouched here (it stays
  // untouched until meeting.uploaded, docs/meet-bot.md); the dashboard
  // watches the bot's own lifecycle via the "bot" SSE event instead.
  app.post("/meetings/:id/bot", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const body = inviteBotSchema.parse(request.body ?? {});
    const { tenantId } = request.auth!;

    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    const meetUrl = body.meetUrl ?? meeting.meetUrl;
    if (!meetUrl) {
      return reply.badRequest("meetUrl is required (meeting has none on file)");
    }

    const message: BotSpawnV1 = {
      v: 1,
      tenant_id: tenantId,
      meeting_id: id,
      meet_url: meetUrl,
      display_name: body.displayName ?? null,
      requested_at: new Date().toISOString(),
    };

    try {
      await app.queue.publish(ROUTING_KEYS.botSpawn, message);
    } catch (err) {
      request.log.error(err, "failed to enqueue bot.spawn");
      return reply.serviceUnavailable("queue unavailable, retry shortly");
    }
    return reply.code(202).send({ requested: true });
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

  // Ticket 3.1/3.4 — the extractor's summary + decisions, once it's run.
  // Null (not 404) is the expected shape while extraction is still pending.
  app.get("/meetings/:id/summary", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { tenantId } = request.auth!;
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();

    const summary = await getSummary(app.db, tenantId, id);
    if (!summary) return { summary: null };
    return {
      summary: {
        summary: summary.summary,
        decisions: summary.decisionsJsonb,
        model: summary.model,
        emailSentAt: summary.emailSentAt,
      },
    };
  });

  // Ticket 3.4: approval-gated send (CLAUDE.md — never auto-sent). Sends to
  // the requesting user's own address; there's no attendee roster to fan out
  // to before the Phase 6 calendar integration lands.
  app.post("/meetings/:id/summary-email", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { tenantId, userId } = request.auth!;

    if (!app.email) {
      return reply.serviceUnavailable("email is not configured");
    }
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    const summary = await getSummary(app.db, tenantId, id);
    if (!summary) return reply.conflict("no summary yet — extraction hasn't run");
    const user = await findUserById(app.db, tenantId, userId);
    if (!user) return reply.notFound();

    const items = await listActionItemsForMeeting(app.db, tenantId, id);
    const decisions = summary.decisionsJsonb as Array<{ text: string }>;
    const text = [
      `Summary: ${summary.summary}`,
      "",
      "Decisions:",
      ...(decisions.length ? decisions.map((d) => `- ${d.text}`) : ["(none)"]),
      "",
      "Action items:",
      ...(items.length
        ? items.map((i) => `- ${i.text}${i.ownerName ? ` (${i.ownerName})` : ""}`)
        : ["(none)"]),
    ].join("\n");
    const html =
      `<p><strong>Summary:</strong> ${escapeHtml(summary.summary)}</p>` +
      `<p><strong>Decisions:</strong></p><ul>${
        decisions.length
          ? decisions.map((d) => `<li>${escapeHtml(d.text)}</li>`).join("")
          : "<li>(none)</li>"
      }</ul>` +
      `<p><strong>Action items:</strong></p><ul>${
        items.length
          ? items
              .map(
                (i) =>
                  `<li>${escapeHtml(i.text)}${i.ownerName ? ` (${escapeHtml(i.ownerName)})` : ""}</li>`,
              )
              .join("")
          : "<li>(none)</li>"
      }</ul>`;

    await app.email.send({
      to: user.email,
      subject: `Meeting summary: ${meeting.title}`,
      text,
      html,
    });
    const updated = await markSummaryEmailSent(app.db, tenantId, id);
    return { emailSentAt: updated?.emailSentAt ?? new Date() };
  });

  // Ticket 3.7 (D65): the follow-up draft — the last body actually sent, if
  // any (so re-editing starts from what went out, not a wiped slate), else a
  // fresh default composed from the current summary/action items. Null
  // (not 404) before extraction has run, same "not ready yet" shape as
  // GET .../summary.
  app.get("/meetings/:id/followup", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { tenantId } = request.auth!;
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();

    const [summary, items, lastSent] = await Promise.all([
      getSummary(app.db, tenantId, id),
      listActionItemsForMeeting(app.db, tenantId, id),
      getLastFollowup(app.db, tenantId, id),
    ]);
    if (!summary) return { followup: null };

    const body =
      lastSent?.body ??
      composeDefaultFollowup({
        meetingTitle: meeting.title,
        summary: summary.summary,
        decisions: summary.decisionsJsonb as Array<{ text: string }>,
        actionItems: items.map((i) => ({ text: i.text, ownerName: i.ownerName })),
      });
    return { followup: { body, sentAt: lastSent?.sentAt ?? null } };
  });

  // Ticket 3.7: approval-gated send (CLAUDE.md — drafts, never auto-sends).
  // The body is whatever the human last edited client-side — trusted as-is,
  // same as any other user-authored email compose box — and sent to the
  // requesting user's own address (no attendee roster yet, same 3.4
  // caution).
  app.post("/meetings/:id/followup-send", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { body } = followupSendSchema.parse(request.body);
    const { tenantId, userId } = request.auth!;

    if (!app.email) {
      return reply.serviceUnavailable("email is not configured");
    }
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    const user = await findUserById(app.db, tenantId, userId);
    if (!user) return reply.notFound();

    await app.email.send({
      to: user.email,
      subject: `Follow-up: ${meeting.title}`,
      text: body,
      html: `<pre style="font-family:inherit;white-space:pre-wrap">${escapeHtml(body)}</pre>`,
    });
    const saved = await recordFollowupSent(app.db, tenantId, id, body);
    return { sentAt: saved.sentAt };
  });

  // Ticket 3.3 — tenant-wide action items dashboard (across all meetings).
  app.get("/action-items", protectedOpts, async (request) => {
    const { tenantId } = request.auth!;
    const rows = await listActionItems(app.db, tenantId);
    return {
      actionItems: rows.map((r) => ({
        ...actionItemView(r),
        meetingTitle: r.meetingTitle,
      })),
    };
  });

  app.get("/meetings/:id/action-items", protectedOpts, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { tenantId } = request.auth!;
    const meeting = await findMeetingById(app.db, tenantId, id);
    if (!meeting) return reply.notFound();
    const rows = await listActionItemsForMeeting(app.db, tenantId, id);
    return { actionItems: rows.map(actionItemView) };
  });

  // Ticket 3.3 — "assign, mark done": ownerUserId is caller-supplied, so it
  // gets the same cross-tenant check as the 2.6 speaker-rename endpoint
  // before it's allowed to land on this row (D20).
  app.patch(
    "/meetings/:id/action-items/:itemId",
    protectedOpts,
    async (request, reply) => {
      const { id, itemId } = actionItemParamSchema.parse(request.params);
      const body = updateActionItemSchema.parse(request.body);
      const { tenantId } = request.auth!;

      if (body.ownerUserId) {
        const owner = await findUserById(app.db, tenantId, body.ownerUserId);
        if (!owner) return reply.badRequest("ownerUserId does not belong to this tenant");
      }

      const updated = await updateActionItem(app.db, tenantId, id, itemId, body);
      if (!updated) return reply.notFound();
      return actionItemView(updated);
    },
  );

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

    const unsubscribe = app.events.subscribe(auth.tenantId, (event: PipelineEventV1) => {
      if (event.meeting_id !== id) return;
      if (event.type === "bot.status") {
        // Ticket 5.5: a bot session's lifecycle state isn't the meeting's
        // pipeline status (meeting.status stays untouched until
        // meeting.uploaded) — its own SSE event name, same reasoning as
        // extraction below.
        sendSse(reply, "bot", {
          meeting_id: event.meeting_id,
          sessionId: event.session_id,
          state: event.state,
          detail: event.detail,
        });
        return;
      }
      // 3.1/3.2 (D59): extraction never changes meeting.status, so it gets
      // its own SSE event name — the dashboard uses it to refetch the
      // summary/action items without confusing it for a transcript-state
      // transition.
      const name = event.type === "meeting.extraction" ? "extraction" : "status";
      sendSse(reply, name, {
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

// Ticket 3.4: the summary/action-item text going into the HTML email body is
// LLM-extracted transcript content, not markup — escape it so a transcript
// containing "<" or "&" can't inject into the sent email.
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
