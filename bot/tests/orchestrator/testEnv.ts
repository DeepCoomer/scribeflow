import type { Env } from "../../src/orchestrator/config.js";

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE_URL: "postgres://scribeflow:scribeflow@localhost:55432/scribeflow",
    RABBITMQ_URL: "amqp://scribeflow:scribeflow@localhost:5672",
    R2_ACCOUNT_ID: undefined,
    R2_ACCESS_KEY_ID: undefined,
    R2_SECRET_ACCESS_KEY: undefined,
    R2_BUCKET: "scribeflow",
    R2_ENDPOINT: undefined,
    UPLOAD_URL_TTL_S: 900,
    BOT_MAX_CONCURRENT: 1,
    BOT_IMAGE: "scribeflow-bot:latest",
    BOT_SPAWN_TTL_S: 1800,
    CONTROL_PLANE_PORT: 8080,
    CONTROL_PLANE_HOST: "orchestrator",
    BOT_HEARTBEAT_TIMEOUT_S: 60,
    BOT_REAPER_INTERVAL_S: 15,
    BOT_DISPLAY_NAME: "ScribeFlow Notetaker",
    BOT_ADMISSION_TIMEOUT_S: 300,
    BOT_JOIN_REQUEST_ATTEMPTS: 3,
    BOT_LONE_PARTICIPANT_S: 60,
    BOT_NO_ONE_JOINED_S: 600,
    BOT_MAX_DURATION_S: 7200,
    BOT_SEGMENT_S: 300,
    BOT_DEBUG_VNC: false,
    BOT_STORAGE_STATE_PATH: undefined,
    DOCKER_SOCKET_PATH: "/var/run/docker.sock",
    DOCKER_NETWORK: undefined,
    ...overrides,
  };
}
