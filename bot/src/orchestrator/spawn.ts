import { randomBytes } from "node:crypto";
import type { ConsumeMessage } from "amqplib";
import { botSpawnV1, type BotSpawnV1 } from "./messages.js";
import type { Db } from "./db.js";
import type { DockerClient } from "./docker.js";
import type { SessionRegistry } from "./sessionRegistry.js";
import type { OrchestratorQueue } from "./queue.js";
import { controlPlaneUrl, type Env } from "./config.js";
import { getLogger } from "../logging.js";

const log = getLogger("orchestrator.spawn");

export type SpawnDeps = {
  db: Db;
  docker: DockerClient;
  sessionRegistry: SessionRegistry;
  queue: OrchestratorQueue;
  env: Env;
};

/** Builds the env a bot container is launched with — BOT_CONFIG (meeting id,
 * Meet URL, display name, session token per docs/meet-bot.md, extended with
 * sessionId/orchestratorUrl/platform) plus the process-wide defaults from
 * the config table. Shared between the fresh-spawn path below and the
 * reaper's one-automatic-rejoin path (D71) — same container shape either
 * way. */
export function buildBotContainerEnv(
  env: Env,
  fields: {
    sessionId: string;
    sessionToken: string;
    tenantId: string;
    meetingId: string;
    meetUrl: string;
    displayName: string | null;
  },
): Record<string, string> {
  const botConfig = {
    tenantId: fields.tenantId,
    meetingId: fields.meetingId,
    sessionId: fields.sessionId,
    sessionToken: fields.sessionToken,
    meetUrl: fields.meetUrl,
    displayName: fields.displayName ?? env.BOT_DISPLAY_NAME,
    orchestratorUrl: controlPlaneUrl(env),
    platform: "meet" as const,
  };
  return {
    BOT_CONFIG: JSON.stringify(botConfig),
    BOT_ADMISSION_TIMEOUT_S: String(env.BOT_ADMISSION_TIMEOUT_S),
    BOT_JOIN_REQUEST_ATTEMPTS: String(env.BOT_JOIN_REQUEST_ATTEMPTS),
    BOT_LONE_PARTICIPANT_S: String(env.BOT_LONE_PARTICIPANT_S),
    BOT_NO_ONE_JOINED_S: String(env.BOT_NO_ONE_JOINED_S),
    BOT_MAX_DURATION_S: String(env.BOT_MAX_DURATION_S),
    BOT_SEGMENT_S: String(env.BOT_SEGMENT_S),
    BOT_DISPLAY_NAME: env.BOT_DISPLAY_NAME,
    BOT_DEBUG_VNC: env.BOT_DEBUG_VNC ? "1" : "0",
    ...(env.BOT_STORAGE_STATE_PATH
      ? { BOT_STORAGE_STATE_PATH: env.BOT_STORAGE_STATE_PATH }
      : {}),
  };
}

export async function spawnBotContainer(
  deps: Pick<SpawnDeps, "docker" | "env">,
  fields: {
    sessionId: string;
    sessionToken: string;
    tenantId: string;
    meetingId: string;
    meetUrl: string;
    displayName: string | null;
  },
): Promise<string> {
  const { id } = await deps.docker.runDetached({
    name: `scribeflow-bot-${fields.sessionId}`,
    image: deps.env.BOT_IMAGE,
    env: buildBotContainerEnv(deps.env, fields),
    ...(deps.env.DOCKER_NETWORK ? { network: deps.env.DOCKER_NETWORK } : {}),
  });
  return id;
}

export function makeSpawnHandler(
  deps: SpawnDeps,
): (msg: ConsumeMessage) => Promise<void> {
  return async function handleSpawnMessage(msg: ConsumeMessage): Promise<void> {
    const ack = () => deps.queue.channel.ack(msg);

    let parsed: BotSpawnV1;
    try {
      parsed = botSpawnV1.parse(JSON.parse(msg.content.toString()));
    } catch (err) {
      log.error("spawn.malformed", { error: String(err) });
      ack();
      return;
    }

    // D31: a bot must never join a meeting that already ended. The queue's
    // own TTL is belt-and-suspenders for anything delivered just under the
    // wire.
    const requestedAtMs = Date.parse(parsed.requested_at);
    const ageS = (Date.now() - requestedAtMs) / 1000;
    if (!Number.isFinite(requestedAtMs) || ageS > deps.env.BOT_SPAWN_TTL_S) {
      log.info("spawn.stale_dropped", { meetingId: parsed.meeting_id, ageS });
      ack();
      return;
    }

    // One non-terminal session per meeting (invariant 3's deterministic-id
    // idempotency rule, job key "{meetingId}:bot:0").
    const existing = await deps.db.findNonTerminalSessionForMeeting(parsed.meeting_id);
    if (existing) {
      log.info("spawn.skipped_already_has_session", { meetingId: parsed.meeting_id });
      ack();
      return;
    }

    const jobKey = `${parsed.meeting_id}:bot:0`;
    const sessionToken = randomBytes(24).toString("hex");
    const session = await deps.db.createSession({
      tenantId: parsed.tenant_id,
      meetingId: parsed.meeting_id,
      jobKey,
      meetUrl: parsed.meet_url,
      sessionToken,
    });

    try {
      const containerId = await spawnBotContainer(deps, {
        sessionId: session.id,
        sessionToken,
        tenantId: parsed.tenant_id,
        meetingId: parsed.meeting_id,
        meetUrl: parsed.meet_url,
        displayName: parsed.display_name,
      });
      await deps.db.setContainerId(session.id, containerId);
    } catch (err) {
      log.error("spawn.container_failed", {
        meetingId: parsed.meeting_id,
        error: String(err),
      });
      await deps.db.recordEvent(session.id, "failed", `spawn failed: ${String(err)}`);
      ack();
      return;
    }

    // Held unacked until the session reaches a terminal state — the static
    // semaphore (D72, see queue.ts's prefetch comment).
    deps.sessionRegistry.registerPendingAck(session.id, ack);
    log.info("spawn.container_started", {
      meetingId: parsed.meeting_id,
      sessionId: session.id,
    });
  };
}
