import amqplib, {
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
} from "amqplib";
import type { Env } from "./config.js";
import {
  buildBotStatusEventV1,
  buildMeetingFinalizeV1,
  type BotSessionState,
} from "./messages.js";
import { getLogger } from "../logging.js";

const log = getLogger("orchestrator.queue");

export const PIPELINE_EXCHANGE = "pipeline";
export const EVENTS_EXCHANGE = "events";
export const BOT_SPAWN_QUEUE = "q.bot_spawn";
export const BOT_SPAWN_ROUTING_KEY = "bot.spawn";
export const MEETING_FINALIZE_ROUTING_KEY = "meeting.finalize";

export type OrchestratorQueue = {
  channel: ConfirmChannel;
  publishFinalize(tenantId: string, meetingId: string): Promise<void>;
  publishBotStatus(fields: {
    tenantId: string;
    meetingId: string;
    sessionId: string;
    state: BotSessionState;
    detail?: string | null;
  }): Promise<void>;
  consumeSpawn(onMessage: (msg: ConsumeMessage) => void): Promise<void>;
  close(): Promise<void>;
};

// No reconnect loop, by design (matches workers/scribeflow_workers/
// framework.py's Worker: a dropped connection exits the process and
// infra/compose.yml's `restart: unless-stopped` brings it back — same
// precedent as every other long-running pipeline service in this repo).
export async function connectQueue(env: Env): Promise<{
  connection: ChannelModel;
  queue: OrchestratorQueue;
}> {
  const connection = await amqplib.connect(env.RABBITMQ_URL);
  const channel = await connection.createConfirmChannel();

  await channel.assertExchange(PIPELINE_EXCHANGE, "topic", { durable: true });
  await channel.assertExchange(EVENTS_EXCHANGE, "fanout", { durable: true });
  // Ticket 5.5 (D31/D70/D72): no retry ladder — a stale spawn just expires.
  await channel.assertQueue(BOT_SPAWN_QUEUE, {
    durable: true,
    arguments: { "x-message-ttl": env.BOT_SPAWN_TTL_S * 1000 },
  });
  await channel.bindQueue(BOT_SPAWN_QUEUE, PIPELINE_EXCHANGE, BOT_SPAWN_ROUTING_KEY);

  // Static semaphore (D72): RabbitMQ won't deliver more than this many
  // unacked spawn messages at once. A session's spawn message is acked only
  // once it reaches a terminal state (see reaper.ts / controlPlaneServer.ts),
  // so this prefetch *is* BOT_MAX_CONCURRENT.
  await channel.prefetch(env.BOT_MAX_CONCURRENT, false);

  connection.on("close", () => {
    log.error("connection_closed");
    process.exit(1);
  });
  connection.on("error", (err) => log.error("connection_error", { error: String(err) }));

  const publish = (exchange: string, routingKey: string, body: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      channel.publish(
        exchange,
        routingKey,
        Buffer.from(JSON.stringify(body)),
        { persistent: true, contentType: "application/json" },
        (err) => (err ? reject(err) : resolve()),
      );
    });

  const queue: OrchestratorQueue = {
    channel,
    async publishFinalize(tenantId, meetingId) {
      await publish(
        PIPELINE_EXCHANGE,
        MEETING_FINALIZE_ROUTING_KEY,
        buildMeetingFinalizeV1(tenantId, meetingId),
      );
    },
    async publishBotStatus(fields) {
      await publish(EVENTS_EXCHANGE, "", buildBotStatusEventV1(fields));
    },
    async consumeSpawn(onMessage) {
      await channel.consume(BOT_SPAWN_QUEUE, (msg) => {
        if (msg) onMessage(msg);
      });
    },
    async close() {
      await connection.close();
    },
  };

  return { connection, queue };
}
