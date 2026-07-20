import type { BotSessionRow, Db } from "./db.js";
import type { DockerClient } from "./docker.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { OrchestratorQueue } from "./queue.js";
import type { Env } from "./config.js";
import { spawnBotContainer } from "./spawn.js";
import { getLogger } from "../logging.js";

const log = getLogger("orchestrator.reaper");

export type ReaperDeps = {
  db: Db;
  docker: DockerClient;
  sessionRegistry: SessionRegistry;
  queue: OrchestratorQueue;
  env: Env;
};

// Container exited or heartbeat silent > BOT_HEARTBEAT_TIMEOUT_S ->
// inspect, record outcome, force-remove, publish meeting.finalize if any
// segments were uploaded (docs/meet-bot.md). On unexpected death mid-
// meeting (last known state was "recording") it attempts exactly one
// automatic rejoin (D71) before giving up.
export async function runReaperPass(deps: ReaperDeps): Promise<void> {
  const stale = await deps.db.listStaleNonTerminal(deps.env.BOT_HEARTBEAT_TIMEOUT_S);
  for (const session of stale) {
    try {
      await reapOne(deps, session);
    } catch (err) {
      log.error("reaper.session_failed", { sessionId: session.id, error: String(err) });
    }
  }
}

async function reapOne(deps: ReaperDeps, session: BotSessionRow): Promise<void> {
  const status = session.containerId
    ? await deps.docker.inspect(session.containerId)
    : null;
  // A running container that's still heartbeating within the grace window
  // wouldn't have been selected by listStaleNonTerminal in the first place;
  // reaching here at all means either the container is gone/exited, or the
  // heartbeat has genuinely gone silent while docker still thinks it's
  // running (a wedged bot process) — both are reaper territory.
  if (status?.running) {
    log.warn("reaper.heartbeat_silent_but_container_running", { sessionId: session.id });
  }

  if (session.containerId) {
    await deps.docker.removeForce(session.containerId);
  }

  const canRejoin = session.state === "recording" && !session.rejoined;
  if (canRejoin) {
    log.info("reaper.attempting_rejoin", { sessionId: session.id });
    try {
      const containerId = await spawnBotContainer(deps, {
        sessionId: session.id,
        sessionToken: session.sessionToken,
        tenantId: session.tenantId,
        meetingId: session.meetingId,
        meetUrl: session.meetUrl,
        displayName: null,
      });
      await deps.db.markRejoined(session.id, containerId);
      return;
    } catch (err) {
      log.error("reaper.rejoin_failed", { sessionId: session.id, error: String(err) });
      // Falls through to the terminal-failure path below.
    }
  }

  const detail = canRejoin
    ? "reaper: rejoin attempt failed"
    : "reaper: heartbeat silent and container gone";
  await deps.db.recordEvent(session.id, "failed", detail);
  await deps.queue
    .publishBotStatus({
      tenantId: session.tenantId,
      meetingId: session.meetingId,
      sessionId: session.id,
      state: "failed",
      detail,
    })
    .catch((err: unknown) =>
      log.warn("publish_bot_status_failed", { error: String(err) }),
    );

  deps.sessionRegistry.resolveTerminal(session.id);
  if (session.segmentsUploaded > 0) {
    await deps.queue
      .publishFinalize(session.tenantId, session.meetingId)
      .catch((err: unknown) =>
        log.error("publish_finalize_failed", { error: String(err) }),
      );
  }
}

export function startReaper(deps: ReaperDeps): () => void {
  const timer = setInterval(() => {
    void runReaperPass(deps).catch((err: unknown) =>
      log.error("reaper.pass_failed", { error: String(err) }),
    );
  }, deps.env.BOT_REAPER_INTERVAL_S * 1000);
  return () => clearInterval(timer);
}
