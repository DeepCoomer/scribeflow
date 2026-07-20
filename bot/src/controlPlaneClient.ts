import type { SessionConfig } from "./config.js";
import type { BotState } from "./state.js";

// HTTP client to the orchestrator's control plane (ticket 5.5, D70): the bot
// container holds zero infra credentials — R2, Postgres, and RabbitMQ are
// all reached indirectly through these three calls, authenticated with the
// per-session token the orchestrator minted at spawn time.

export type ControlPlaneClient = {
  heartbeat(
    state: BotState,
    info?: { participantCount?: number; rmsHealthy?: boolean },
  ): Promise<void>;
  event(state: BotState, detail?: string): Promise<void>;
  segmentUrl(idx: number, startedAtMs: number): Promise<{ url: string; key: string }>;
  debugUrl(name: string): Promise<{ url: string; key: string }>;
};

export function createControlPlaneClient(
  session: SessionConfig,
  fetchImpl: typeof fetch = fetch,
): ControlPlaneClient {
  const base = session.orchestratorUrl.replace(/\/$/, "");

  async function post(path: string, body: unknown): Promise<Response> {
    const res = await fetchImpl(`${base}/sessions/${session.sessionId}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${session.sessionToken}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`control plane ${path} failed: ${res.status} ${await res.text()}`);
    }
    return res;
  }

  return {
    async heartbeat(state, info = {}) {
      await post("/heartbeat", { state, ...info });
    },
    async event(state, detail) {
      await post("/event", { state, detail: detail ?? null });
    },
    async segmentUrl(idx, startedAtMs) {
      const res = await post("/segment-url", { idx, startedAtMs });
      return (await res.json()) as { url: string; key: string };
    },
    async debugUrl(name) {
      const res = await post("/debug-url", { name });
      return (await res.json()) as { url: string; key: string };
    },
  };
}
