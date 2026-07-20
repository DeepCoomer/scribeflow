import { describe, it, expect, vi } from "vitest";
import { createControlPlaneClient } from "../src/controlPlaneClient.js";
import type { SessionConfig } from "../src/config.js";

const session: SessionConfig = {
  tenantId: "t1",
  meetingId: "m1",
  sessionId: "s1",
  sessionToken: "secret-token",
  meetUrl: "https://meet.google.com/abc-defg-hij",
  orchestratorUrl: "http://orchestrator:8080/",
  platform: "meet",
};

function fakeFetch(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

describe("createControlPlaneClient", () => {
  it("authenticates with the per-session bearer token and posts under /sessions/:id", async () => {
    const { fn, calls } = fakeFetch();
    const cp = createControlPlaneClient(session, fn);
    await cp.heartbeat("recording", { participantCount: 2 });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://orchestrator:8080/sessions/s1/heartbeat");
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: "Bearer secret-token",
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      state: "recording",
      participantCount: 2,
    });
  });

  it("returns the presigned segment URL from the response body", async () => {
    const { fn } = fakeFetch(200, { url: "https://r2.example/put", key: "tenant/t1/x" });
    const cp = createControlPlaneClient(session, fn);
    const result = await cp.segmentUrl(3, 12345);
    expect(result).toEqual({ url: "https://r2.example/put", key: "tenant/t1/x" });
  });

  it("throws on a non-2xx response instead of silently continuing", async () => {
    const { fn } = fakeFetch(401, { error: "bad token" });
    const cp = createControlPlaneClient(session, fn);
    await expect(cp.event("done")).rejects.toThrow(/401/);
  });
});
