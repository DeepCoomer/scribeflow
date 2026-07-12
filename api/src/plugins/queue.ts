import fp from "fastify-plugin";
import amqplib, { type ChannelModel, type ConfirmChannel } from "amqplib";
import type { FastifyInstance } from "fastify";
import {
  PIPELINE_EXCHANGE,
  EVENTS_EXCHANGE,
  WORK_QUEUES,
  RETRY_TIERS,
  PARKING_QUEUE,
  retryQueueName,
} from "../queue/topology.js";

export type EventHandler = (event: unknown) => void;

export type Queue = {
  /** Publish to the pipeline exchange; rejects if the broker is unreachable. */
  publish: (routingKey: string, message: unknown) => Promise<void>;
  /** Register a consumer of the events fanout exchange (survives reconnects). */
  onEvent: (handler: EventHandler) => void;
  isConnected: () => boolean;
};

async function assertTopology(ch: ConfirmChannel) {
  await ch.assertExchange(PIPELINE_EXCHANGE, "topic", { durable: true });
  await ch.assertExchange(EVENTS_EXCHANGE, "fanout", { durable: true });

  for (const spec of WORK_QUEUES) {
    // Quorum work queue; messages nacked without the framework's explicit
    // retry-republish still land on the first retry tier via DLX.
    await ch.assertQueue(spec.name, {
      durable: true,
      arguments: {
        "x-queue-type": "quorum",
        "x-dead-letter-exchange": "",
        "x-dead-letter-routing-key": retryQueueName(spec.name, RETRY_TIERS[0].suffix),
      },
    });
    for (const binding of spec.bindings) {
      await ch.bindQueue(spec.name, PIPELINE_EXCHANGE, binding);
    }
    for (const tier of RETRY_TIERS) {
      // Classic queue: TTL expiry dead-letters straight back to the work
      // queue by name (default exchange), independent of topic bindings —
      // Phase 2 can rebind routing keys without touching the retry path.
      await ch.assertQueue(retryQueueName(spec.name, tier.suffix), {
        durable: true,
        arguments: {
          "x-message-ttl": tier.ttlMs,
          "x-dead-letter-exchange": "",
          "x-dead-letter-routing-key": spec.name,
        },
      });
    }
  }

  await ch.assertQueue(PARKING_QUEUE, {
    durable: true,
    arguments: { "x-queue-type": "quorum" },
  });
}

// Owns the AMQP connection lifecycle: connect on boot, reconnect with capped
// backoff, re-establish the events consumer after every reconnect. Publishes
// while disconnected reject (routes translate that to a 503) rather than
// buffering — an enqueue the caller believes happened must have happened.
export default fp(async function queuePlugin(app: FastifyInstance) {
  const url = app.config.RABBITMQ_URL;
  let connection: ChannelModel | null = null;
  let channel: ConfirmChannel | null = null;
  let closing = false;
  let reconnectDelayMs = 1_000;
  const eventHandlers: EventHandler[] = [];

  async function consumeEvents(ch: ConfirmChannel) {
    // Exclusive per-instance queue: every API instance sees every event and
    // forwards to its own SSE subscribers.
    const { queue } = await ch.assertQueue("", { exclusive: true, autoDelete: true });
    await ch.bindQueue(queue, EVENTS_EXCHANGE, "");
    await ch.consume(
      queue,
      (msg) => {
        if (!msg) return;
        ch.ack(msg);
        let event: unknown;
        try {
          event = JSON.parse(msg.content.toString());
        } catch {
          app.log.warn("dropping malformed event message");
          return;
        }
        for (const handler of eventHandlers) handler(event);
      },
      { noAck: false },
    );
  }

  async function connect(): Promise<void> {
    const conn = await amqplib.connect(url);
    const ch = await conn.createConfirmChannel();
    await assertTopology(ch);
    await consumeEvents(ch);

    conn.on("close", () => {
      connection = null;
      channel = null;
      if (closing) return;
      app.log.warn({ delayMs: reconnectDelayMs }, "rabbitmq connection lost");
      scheduleReconnect();
    });
    conn.on("error", (err) => app.log.error(err, "rabbitmq connection error"));

    connection = conn;
    channel = ch;
    reconnectDelayMs = 1_000;
    app.log.info("rabbitmq connected, topology asserted");
  }

  function scheduleReconnect() {
    const timer = setTimeout(() => {
      connect().catch((err) => {
        app.log.error(err, "rabbitmq reconnect failed");
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
        if (!closing) scheduleReconnect();
      });
    }, reconnectDelayMs);
    timer.unref();
  }

  const queue: Queue = {
    async publish(routingKey, message) {
      const ch = channel;
      if (!ch) throw new Error("queue unavailable");
      const body = Buffer.from(JSON.stringify(message));
      await new Promise<void>((resolve, reject) => {
        ch.publish(
          PIPELINE_EXCHANGE,
          routingKey,
          body,
          { persistent: true, contentType: "application/json" },
          (err) => (err ? reject(err) : resolve()),
        );
      });
    },
    onEvent(handler) {
      eventHandlers.push(handler);
    },
    isConnected: () => channel !== null,
  };

  app.decorate("queue", queue);

  // Boot tolerates a down broker (dev ergonomics; health stays green for
  // /health) — but production publishes fail loudly until reconnect wins.
  try {
    await connect();
  } catch (err) {
    app.log.error(err, "rabbitmq unavailable at boot — will keep retrying");
    scheduleReconnect();
  }

  app.addHook("onClose", async () => {
    closing = true;
    if (connection) await connection.close().catch(() => undefined);
  });
});
