import { describe, it, expect, beforeAll, afterAll } from "vitest";
import amqplib from "amqplib";
import { loadEnv } from "../config.js";
import { buildApp } from "../app.js";
import { meetingSpeakers, transcriptSegments } from "../db/schema.js";
import { SLICER_QUEUE } from "../queue/topology.js";
import { meetingUploadedV1 } from "../queue/messages.js";

// Integration tests for tickets 1.1/1.5/1.6: need the compose Postgres
// (migrated) AND RabbitMQ up — same prerequisites as `pnpm test` documents.
// R2 is faked: presigning is offline SigV4, so no bucket has to exist.
const env = {
  ...loadEnv(),
  R2_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_BUCKET: "scribeflow-test",
};

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let token: string;
let tenantId: string;

async function registerUser(a: App, email: string) {
  const res = await a.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      tenantName: "Pipeline Test Co",
      name: "Pat Test",
      email,
      password: "correct-horse-battery-staple",
    },
  });
  expect(res.statusCode).toBe(201);
  const t = res.json().token as string;
  const payload = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
  return { token: t, tenantId: payload.tenantId as string };
}

async function createMeeting(): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: "/meetings",
    headers: { authorization: `Bearer ${token}` },
    payload: { title: "Weekly sync" },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id;
}

beforeAll(async () => {
  app = await buildApp(env);
  expect(app.queue.isConnected()).toBe(true);
  ({ token, tenantId } = await registerUser(app, `meet-${Date.now()}@example.com`));
});

afterAll(async () => {
  await app.close();
});

describe("upload flow (1.1)", () => {
  it("mints a tenant-scoped presigned URL and enqueues on completion", async () => {
    const meetingId = await createMeeting();

    // Drain the work queue so the assertion below sees only our message.
    const conn = await amqplib.connect(env.RABBITMQ_URL);
    const ch = await conn.createChannel();
    await ch.purgeQueue(SLICER_QUEUE.name);

    const urlRes = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/upload-url`,
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: "audio/mpeg", sizeBytes: 1024 },
    });
    expect(urlRes.statusCode).toBe(200);
    const { url, key } = urlRes.json();
    expect(key).toBe(`tenant/${tenantId}/meeting/${meetingId}/audio.mp3`);
    expect(url).toContain(`/tenant/${tenantId}/meeting/${meetingId}/`);
    // The declared size is part of the signature — the URL can't be reused
    // for a bigger object.
    expect(url).toContain("X-Amz-SignedHeaders=content-length");

    const doneRes = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/uploaded`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(doneRes.statusCode).toBe(200);
    expect(doneRes.json().status).toBe("processing");

    // The contract message must be on q.slicer (D45 realized: the slicer,
    // not the transcriber, now owns meeting.uploaded) and parse as v1.
    let raw: amqplib.GetMessage | false = false;
    for (let i = 0; i < 20 && !raw; i++) {
      raw = await ch.get(SLICER_QUEUE.name, { noAck: true });
      if (!raw) await new Promise((r) => setTimeout(r, 100));
    }
    expect(raw).not.toBe(false);
    const message = meetingUploadedV1.parse(
      JSON.parse((raw as amqplib.GetMessage).content.toString()),
    );
    expect(message).toMatchObject({
      v: 1,
      tenant_id: tenantId,
      meeting_id: meetingId,
      r2_key: key,
    });

    // Retrying the completion call must not enqueue a second job.
    const again = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/uploaded`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(again.statusCode).toBe(200);
    const extra = await ch.get(SLICER_QUEUE.name, { noAck: true });
    expect(extra).toBe(false);

    await conn.close();
  });

  it("rejects non-audio content types", async () => {
    const meetingId = await createMeeting();
    const res = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/upload-url`,
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: "application/x-sh", sizeBytes: 10 },
    });
    expect(res.statusCode).toBe(415);
  });

  it("refuses completion before an upload URL was requested", async () => {
    const meetingId = await createMeeting();
    const res = await app.inject({
      method: "POST",
      url: `/meetings/${meetingId}/uploaded`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it("hides meetings from other tenants", async () => {
    const meetingId = await createMeeting();
    const other = await registerUser(app, `other-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "GET",
      url: `/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("transcript viewer (1.5)", () => {
  it("returns segments ordered by start time", async () => {
    const meetingId = await createMeeting();
    await app.db.insert(transcriptSegments).values([
      { meetingId, chunkIdx: 0, startS: 5.2, endS: 9.1, text: "second" },
      { meetingId, chunkIdx: 0, startS: 0.0, endS: 4.8, text: "first" },
    ]);
    const res = await app.inject({
      method: "GET",
      url: `/meetings/${meetingId}/transcript`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { segments } = res.json();
    expect(segments.map((s: { text: string }) => s.text)).toEqual(["first", "second"]);
  });
});

describe("speaker rename (2.6)", () => {
  it("returns seeded speakers with the transcript and lets a user rename one", async () => {
    const meetingId = await createMeeting();
    await app.db.insert(transcriptSegments).values([
      {
        meetingId,
        chunkIdx: 0,
        startS: 0.0,
        endS: 4.0,
        text: "hello",
        speaker: "SPEAKER_00",
      },
    ]);
    await app.db
      .insert(meetingSpeakers)
      .values([{ meetingId, speakerLabel: "SPEAKER_00", displayName: "Speaker 1" }]);

    const transcriptRes = await app.inject({
      method: "GET",
      url: `/meetings/${meetingId}/transcript`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(transcriptRes.statusCode).toBe(200);
    expect(transcriptRes.json().speakers).toEqual([
      {
        speakerLabel: "SPEAKER_00",
        displayName: "Speaker 1",
        userId: null,
        source: "default",
      },
    ]);

    const renameRes = await app.inject({
      method: "PATCH",
      url: `/meetings/${meetingId}/speakers/SPEAKER_00`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Alex" },
    });
    expect(renameRes.statusCode).toBe(200);
    expect(renameRes.json()).toMatchObject({
      speakerLabel: "SPEAKER_00",
      displayName: "Alex",
      source: "user",
    });

    const again = await app.inject({
      method: "GET",
      url: `/meetings/${meetingId}/transcript`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(again.json().speakers[0]).toMatchObject({
      displayName: "Alex",
      source: "user",
    });
  });

  it("404s renaming a label with no seeded row", async () => {
    const meetingId = await createMeeting();
    const res = await app.inject({
      method: "PATCH",
      url: `/meetings/${meetingId}/speakers/SPEAKER_99`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Nobody" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s renaming a speaker on another tenant's meeting", async () => {
    const meetingId = await createMeeting();
    await app.db
      .insert(meetingSpeakers)
      .values([{ meetingId, speakerLabel: "SPEAKER_00", displayName: "Speaker 1" }]);
    const other = await registerUser(app, `speaker-rename-${Date.now()}@example.com`);
    const res = await app.inject({
      method: "PATCH",
      url: `/meetings/${meetingId}/speakers/SPEAKER_00`,
      headers: { authorization: `Bearer ${other.token}` },
      payload: { displayName: "Hijack" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("rejects a userId that does not belong to the caller's tenant (D20)", async () => {
    const meetingId = await createMeeting();
    await app.db
      .insert(meetingSpeakers)
      .values([{ meetingId, speakerLabel: "SPEAKER_00", displayName: "Speaker 1" }]);
    const other = await registerUser(app, `foreign-user-${Date.now()}@example.com`);
    const otherPayload = JSON.parse(
      Buffer.from(other.token.split(".")[1]!, "base64url").toString(),
    );
    const foreignUserId = otherPayload.userId as string;

    const res = await app.inject({
      method: "PATCH",
      url: `/meetings/${meetingId}/speakers/SPEAKER_00`,
      headers: { authorization: `Bearer ${token}` },
      payload: { displayName: "Alex", userId: foreignUserId },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("job status SSE (1.6)", () => {
  it("rejects a missing/invalid token", async () => {
    const meetingId = await createMeeting();
    const bad = await app.inject({
      method: "GET",
      url: `/meetings/${meetingId}/events?token=not-a-jwt`,
    });
    expect(bad.statusCode).toBe(401);
  });

  it("streams the snapshot then live status events", async () => {
    const meetingId = await createMeeting();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");

    const controller = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${address.port}/meetings/${meetingId}/events?token=${token}`,
      { signal: controller.signal, headers: { origin: "http://localhost:5173" } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    // reply.hijack() bypasses @fastify/cors's normal onSend hook entirely
    // (that's the whole point of hijacking), so this route sets the CORS
    // header itself — regression coverage for that gap.
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    async function readUntil(predicate: (chunk: string) => boolean) {
      while (!predicate(buffer)) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended early");
        buffer += decoder.decode(value);
      }
    }

    // Snapshot event arrives immediately with the current status.
    await readUntil((b) => b.includes('"status":"pending"'));

    // A worker-style event for this tenant+meeting is forwarded live.
    app.events.dispatch({
      v: 1,
      type: "meeting.status",
      tenant_id: tenantId,
      meeting_id: meetingId,
      status: "transcribing",
      error: null,
      ts: new Date().toISOString(),
    });
    await readUntil((b) => b.includes('"status":"transcribing"'));

    // Events for other meetings must not leak into this stream.
    app.events.dispatch({
      v: 1,
      type: "meeting.status",
      tenant_id: tenantId,
      meeting_id: "00000000-0000-4000-8000-000000000000",
      status: "failed",
      error: "boom",
      ts: new Date().toISOString(),
    });
    app.events.dispatch({
      v: 1,
      type: "meeting.status",
      tenant_id: tenantId,
      meeting_id: meetingId,
      status: "done",
      error: null,
      ts: new Date().toISOString(),
    });
    await readUntil((b) => b.includes('"status":"done"'));
    expect(buffer).not.toContain('"status":"failed"');

    controller.abort();
  }, 15_000);
});
