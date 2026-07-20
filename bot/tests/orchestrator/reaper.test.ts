import { describe, it, expect } from "vitest";
import { runReaperPass } from "../../src/orchestrator/reaper.js";
import { createSessionRegistry } from "../../src/orchestrator/sessionRegistry.js";
import { makeFakeDb, makeFakeDocker, makeFakeQueue } from "./fakes.js";
import { makeTestEnv } from "./testEnv.js";
import type { BotSessionState } from "../../src/orchestrator/messages.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEETING = "22222222-2222-4222-8222-222222222222";

function makeDeps() {
  const db = makeFakeDb();
  const docker = makeFakeDocker();
  const queue = makeFakeQueue();
  const sessionRegistry = createSessionRegistry();
  const env = makeTestEnv();
  return { db, docker, queue, sessionRegistry, env };
}

async function seedSession(
  deps: ReturnType<typeof makeDeps>,
  fields: {
    state: BotSessionState;
    rejoined?: boolean;
    segmentsUploaded?: number;
    withContainer?: boolean;
  },
) {
  const session = await deps.db.createSession({
    tenantId: TENANT,
    meetingId: MEETING,
    jobKey: `${MEETING}:bot:0`,
    meetUrl: "https://meet.google.com/abc-defg-hij",
    sessionToken: "tok",
  });
  session.state = fields.state;
  session.rejoined = fields.rejoined ?? false;
  session.segmentsUploaded = fields.segmentsUploaded ?? 0;
  if (fields.withContainer) {
    const { id } = await deps.docker.runDetached({ name: "x", image: "y", env: {} });
    deps.docker.containers.set(id, { running: false, exitCode: 137 }); // crashed
    session.containerId = id;
  }
  deps.sessionRegistry.registerPendingAck(session.id, () => undefined);
  return session;
}

describe("runReaperPass", () => {
  it("marks a dead, non-recording session failed, resolves its pending ack, and skips finalize with no segments", async () => {
    const deps = makeDeps();
    const session = await seedSession(deps, { state: "joining", withContainer: true });

    await runReaperPass(deps);

    expect(deps.db.rows.get(session.id)?.state).toBe("failed");
    expect(deps.docker.containers.has(session.containerId!)).toBe(false); // force-removed
    expect(deps.sessionRegistry.hasPending(session.id)).toBe(false);
    expect(deps.queue.finalized).toHaveLength(0);
    expect(deps.queue.botStatuses).toEqual([{ sessionId: session.id, state: "failed" }]);
  });

  it("publishes meeting.finalize when segments were uploaded before the session died", async () => {
    const deps = makeDeps();
    await seedSession(deps, {
      state: "recording",
      rejoined: true,
      segmentsUploaded: 3,
      withContainer: true,
    });

    await runReaperPass(deps);

    expect(deps.queue.finalized).toEqual([{ tenantId: TENANT, meetingId: MEETING }]);
  });

  it("attempts exactly one automatic rejoin when a recording session dies unexpectedly (D71)", async () => {
    const deps = makeDeps();
    const session = await seedSession(deps, {
      state: "recording",
      rejoined: false,
      withContainer: true,
    });

    await runReaperPass(deps);

    const updated = deps.db.rows.get(session.id)!;
    expect(updated.rejoined).toBe(true);
    expect(updated.state).toBe("joining");
    // Rejoin spawns a fresh container: one from seedSession's withContainer,
    // one from the rejoin itself.
    expect(deps.docker.runCalls).toHaveLength(2);
    // Still pending — the session lives on under the same lineage, so the
    // original spawn message must not be acked yet.
    expect(deps.sessionRegistry.hasPending(session.id)).toBe(true);
    expect(deps.queue.finalized).toHaveLength(0);
  });

  it("does not rejoin a second time — a session that already used its rejoin goes straight to failed", async () => {
    const deps = makeDeps();
    const session = await seedSession(deps, {
      state: "recording",
      rejoined: true,
      withContainer: true,
    });

    await runReaperPass(deps);

    expect(deps.db.rows.get(session.id)?.state).toBe("failed");
    expect(deps.docker.runCalls).toHaveLength(1); // only the original seed spawn, no rejoin
    expect(deps.sessionRegistry.hasPending(session.id)).toBe(false);
  });

  it("ignores sessions already in a terminal state", async () => {
    const deps = makeDeps();
    await seedSession(deps, { state: "done" });

    await runReaperPass(deps);

    expect(deps.queue.botStatuses).toHaveLength(0);
  });
});
