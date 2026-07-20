import "dotenv/config";
import { z } from "zod";

const optionalUrl = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().url().optional(),
);

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  RABBITMQ_URL: z.string().default("amqp://scribeflow:scribeflow@localhost:5672"),

  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("scribeflow"),
  R2_ENDPOINT: optionalUrl,
  UPLOAD_URL_TTL_S: z.coerce.number().int().positive().default(900),

  // Static semaphore (D72) — implemented as the AMQP channel's prefetch
  // count on q.bot_spawn: a spawn message is acked only once its session
  // reaches a terminal state, so RabbitMQ itself won't deliver the next one
  // past this many in flight.
  BOT_MAX_CONCURRENT: z.coerce.number().int().positive().default(1),
  BOT_IMAGE: z.string().default("scribeflow-bot:latest"),
  BOT_SPAWN_TTL_S: z.coerce.number().int().positive().default(1800),

  // How bot containers reach this process's control plane on the compose
  // network (D70) — not itself part of docs/meet-bot.md's config table,
  // which only lists what's injected into the *bot* container; this is the
  // orchestrator-side address that value gets derived from.
  CONTROL_PLANE_PORT: z.coerce.number().int().positive().default(8080),
  CONTROL_PLANE_HOST: z.string().default("orchestrator"),

  BOT_HEARTBEAT_TIMEOUT_S: z.coerce.number().int().positive().default(60),
  BOT_REAPER_INTERVAL_S: z.coerce.number().int().positive().default(15),

  BOT_DISPLAY_NAME: z.string().min(1).default("ScribeFlow Notetaker"),
  BOT_ADMISSION_TIMEOUT_S: z.coerce.number().int().positive().default(300),
  BOT_JOIN_REQUEST_ATTEMPTS: z.coerce.number().int().positive().default(3),
  BOT_LONE_PARTICIPANT_S: z.coerce.number().int().positive().default(60),
  BOT_NO_ONE_JOINED_S: z.coerce.number().int().positive().default(600),
  BOT_MAX_DURATION_S: z.coerce.number().int().positive().default(7200),
  BOT_SEGMENT_S: z.coerce.number().int().positive().default(300),
  BOT_DEBUG_VNC: z.coerce.boolean().default(false),
  BOT_STORAGE_STATE_PATH: z.string().optional(),

  DOCKER_SOCKET_PATH: z.string().default("/var/run/docker.sock"),
  // The compose network name so spawned containers can resolve
  // CONTROL_PLANE_HOST — unset means "whatever docker run's default
  // network is" (fine for a bare `docker run` in local dev).
  DOCKER_NETWORK: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error("Invalid orchestrator environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}

export function controlPlaneUrl(env: Env): string {
  return `http://${env.CONTROL_PLANE_HOST}:${env.CONTROL_PLANE_PORT}`;
}
