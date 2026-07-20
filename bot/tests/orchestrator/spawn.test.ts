import { describe, it, expect } from "vitest";
import { makeSpawnHandler } from "../../src/orchestrator/spawn.js";
import { createSessionRegistry } from "../../src/orchestrator/sessionRegistry.js";
import {
  makeFakeDb,
  makeFakeDocker,
  makeFakeQueue,
  fakeConsumeMessage,
} from "./fakes.js";
import { makeTestEnv } from "./testEnv.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const MEETING = "22222222-2222-4222-8222-222222222222";

function spawnPayload(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    tenant_id: TENANT,
    meeting_id: MEETING,
    meet_url: "https://meet.google.com/abc-defg-hij",
    display_name: null,
    requested_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeDeps() {
  const db = makeFakeDb();
  const docker = makeFakeDocker();
  const queue = makeFakeQueue();
  const sessionRegistry = createSessionRegistry();
  const env = makeTestEnv();
  return { db, docker, queue, sessionRegistry, env };
}

describe("makeSpawnHandler", () => {
  it("spawns a container, creates a session, and holds the ack pending (the static semaphore)", async () => {
    const deps = makeDeps();
    const handler = makeSpawnHandler(deps);

    await handler(fakeConsumeMessage(spawnPayload()) as never);

    expect(deps.docker.runCalls).toHaveLength(1);
    const [session] = [...deps.db.rows.values()];
    expect(session?.containerId).toBe("container-1");
    expect(session?.state).toBe("spawning");
    expect(deps.queue.acked).toHaveLength(0); // not acked yet
    expect(deps.sessionRegistry.hasPending(session!.id)).toBe(true);

    const env = deps.docker.runCalls[0]!.env;
    const botConfig = JSON.parse(env.BOT_CONFIG!);
    expect(botConfig).toMatchObject({
      tenantId: TENANT,
      meetingId: MEETING,
      meetUrl: "https://meet.google.com/abc-defg-hij",
      platform: "meet",
    });
    expect(botConfig.sessionToken).toBeTypeOf("string");
    expect(botConfig.sessionToken.length).toBeGreaterThan(10);
  });

  it("acks and drops a stale request without spawning anything (D31)", async () => {
    const deps = makeDeps();
    const handler = makeSpawnHandler(deps);
    const staleTimestamp = new Date(
      Date.now() - deps.env.BOT_SPAWN_TTL_S * 1000 - 60_000,
    ).toISOString();

    await handler(
      fakeConsumeMessage(spawnPayload({ requested_at: staleTimestamp })) as never,
    );

    expect(deps.docker.runCalls).toHaveLength(0);
    expect(deps.db.rows.size).toBe(0);
    expect(deps.queue.acked).toHaveLength(1);
  });

  it("acks and skips when a non-terminal session already exists for the meeting", async () => {
    const deps = makeDeps();
    await deps.db.createSession({
      tenantId: TENANT,
      meetingId: MEETING,
      jobKey: `${MEETING}:bot:0`,
      meetUrl: "https://meet.google.com/abc-defg-hij",
      sessionToken: "existing-token",
    });
    const handler = makeSpawnHandler(deps);

    await handler(fakeConsumeMessage(spawnPayload()) as never);

    expect(deps.docker.runCalls).toHaveLength(0);
    expect(deps.db.rows.size).toBe(1); // still just the pre-existing one
    expect(deps.queue.acked).toHaveLength(1);
  });

  it("acks immediately on malformed messages instead of crashing the consumer", async () => {
    const deps = makeDeps();
    const handler = makeSpawnHandler(deps);

    await handler({ content: Buffer.from("not json") } as never);

    expect(deps.queue.acked).toHaveLength(1);
    expect(deps.db.rows.size).toBe(0);
  });

  it("marks the session failed and acks immediately when the container fails to start", async () => {
    const deps = makeDeps();
    deps.docker.runDetached = async () => {
      throw new Error("docker daemon unreachable");
    };
    const handler = makeSpawnHandler(deps);

    await handler(fakeConsumeMessage(spawnPayload()) as never);

    const [session] = [...deps.db.rows.values()];
    expect(session?.state).toBe("failed");
    expect(deps.queue.acked).toHaveLength(1);
    expect(deps.sessionRegistry.hasPending(session!.id)).toBe(false);
  });
});
