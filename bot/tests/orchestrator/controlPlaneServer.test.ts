import { describe, it, expect } from "vitest";
import { createControlPlaneServer } from "../../src/orchestrator/controlPlaneServer.js";
import { createSessionRegistry } from "../../src/orchestrator/sessionRegistry.js";
import { makeFakeDb, makeFakeQueue } from "./fakes.js";
import { makeTestEnv } from "./testEnv.js";
import type { R2 } from "../../src/orchestrator/r2.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEETING = "22222222-2222-4222-8222-222222222222";

function makeFakeR2(): R2 & { calls: { key: string; contentType: string }[] } {
  const calls: { key: string; contentType: string }[] = [];
  return {
    calls,
    async presignPut(key, contentType) {
      calls.push({ key, contentType });
      return `https://r2.example/${key}`;
    },
  };
}

async function makeApp(overrides: { r2?: R2 | null } = {}) {
  const db = makeFakeDb();
  const queue = makeFakeQueue();
  const sessionRegistry = createSessionRegistry();
  const env = makeTestEnv();
  const session = await db.createSession({
    tenantId: TENANT,
    meetingId: MEETING,
    jobKey: `${MEETING}:bot:0`,
    meetUrl: "https://meet.google.com/abc-defg-hij",
    sessionToken: "correct-token",
  });
  const r2 = overrides.r2 !== undefined ? overrides.r2 : makeFakeR2();
  const app = createControlPlaneServer({ db, r2, sessionRegistry, queue, env });
  return { app, db, queue, sessionRegistry, session, r2 };
}

describe("control plane server auth", () => {
  it("rejects a request with no bearer token", async () => {
    const { app, session } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/heartbeat`,
      payload: { state: "recording" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a request with the wrong token", async () => {
    const { app, session } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/heartbeat`,
      headers: { authorization: "Bearer wrong-token" },
      payload: { state: "recording" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a token for a session that doesn't exist", async () => {
    const { app } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/does-not-exist/heartbeat`,
      headers: { authorization: "Bearer correct-token" },
      payload: { state: "recording" },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /sessions/:id/heartbeat", () => {
  it("records the state and returns 204", async () => {
    const { app, db, session } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/heartbeat`,
      headers: { authorization: "Bearer correct-token" },
      payload: { state: "recording", participantCount: 2 },
    });
    expect(res.statusCode).toBe(204);
    expect(db.rows.get(session.id)?.state).toBe("recording");
  });
});

describe("POST /sessions/:id/event", () => {
  it("publishes a bot.status event but does not finalize for a non-terminal state", async () => {
    const { app, queue, sessionRegistry, session } = await makeApp();
    sessionRegistry.registerPendingAck(session.id, () => undefined);

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/event`,
      headers: { authorization: "Bearer correct-token" },
      payload: { state: "lobby" },
    });

    expect(res.statusCode).toBe(204);
    expect(queue.botStatuses).toEqual([{ sessionId: session.id, state: "lobby" }]);
    expect(sessionRegistry.hasPending(session.id)).toBe(true);
    expect(queue.finalized).toHaveLength(0);
  });

  it("resolves the pending ack on a terminal state and finalizes when segments were uploaded", async () => {
    const { app, db, queue, sessionRegistry, session } = await makeApp();
    sessionRegistry.registerPendingAck(session.id, () => undefined);
    db.rows.get(session.id)!.segmentsUploaded = 2;

    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/event`,
      headers: { authorization: "Bearer correct-token" },
      payload: { state: "done" },
    });

    expect(res.statusCode).toBe(204);
    expect(sessionRegistry.hasPending(session.id)).toBe(false);
    expect(queue.finalized).toEqual([{ tenantId: TENANT, meetingId: MEETING }]);
  });

  it("does not finalize on a terminal state with zero segments uploaded", async () => {
    const { app, queue, session } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/event`,
      headers: { authorization: "Bearer correct-token" },
      payload: { state: "not_admitted" },
    });
    expect(res.statusCode).toBe(204);
    expect(queue.finalized).toHaveLength(0);
  });
});

describe("POST /sessions/:id/segment-url", () => {
  it("mints a tenant/meeting-scoped presigned URL and increments segmentsUploaded", async () => {
    const { app, db, r2, session } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/segment-url`,
      headers: { authorization: "Bearer correct-token" },
      payload: { idx: 3, startedAtMs: 123456 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.key).toBe(
      `tenant/${TENANT}/meeting/${MEETING}/bot-segments/3_123456.ogg`,
    );
    expect(body.url).toBe(`https://r2.example/${body.key}`);
    expect((r2 as ReturnType<typeof makeFakeR2>).calls[0]?.contentType).toBe("audio/ogg");
    expect(db.rows.get(session.id)?.segmentsUploaded).toBe(1);
  });

  it("503s when object storage isn't configured", async () => {
    const { app, session } = await makeApp({ r2: null });
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/segment-url`,
      headers: { authorization: "Bearer correct-token" },
      payload: { idx: 0, startedAtMs: 0 },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("POST /sessions/:id/debug-url", () => {
  it("mints a bot-debug-scoped presigned URL", async () => {
    const { app, session } = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${session.id}/debug-url`,
      headers: { authorization: "Bearer correct-token" },
      payload: { name: "not_admitted-123.png" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().key).toBe(
      `tenant/${TENANT}/meeting/${MEETING}/bot-debug/not_admitted-123.png`,
    );
  });
});
