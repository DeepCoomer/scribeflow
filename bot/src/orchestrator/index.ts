import { loadEnv } from "./config.js";
import { connect as connectDb, createDb } from "./db.js";
import { createDockerClient } from "./docker.js";
import { createR2 } from "./r2.js";
import { connectQueue } from "./queue.js";
import { createSessionRegistry } from "./sessionRegistry.js";
import { makeSpawnHandler } from "./spawn.js";
import { startReaper } from "./reaper.js";
import { createControlPlaneServer } from "./controlPlaneServer.js";
import { getLogger } from "../logging.js";

const log = getLogger("orchestrator");

async function main(): Promise<void> {
  const env = loadEnv();
  const sql = connectDb(env.DATABASE_URL);
  const db = createDb(sql);
  const docker = createDockerClient(env);
  const r2 = createR2(env);
  if (!r2) {
    log.warn("r2_not_configured", {
      note: "segment/debug-url endpoints will 503 until R2 credentials are set",
    });
  }

  const { connection, queue } = await connectQueue(env);
  const sessionRegistry = createSessionRegistry();

  const spawnHandler = makeSpawnHandler({ db, docker, sessionRegistry, queue, env });
  await queue.consumeSpawn((msg) => {
    void spawnHandler(msg).catch((err: unknown) =>
      log.error("spawn_handler_crashed", { error: String(err) }),
    );
  });

  const stopReaper = startReaper({ db, docker, sessionRegistry, queue, env });

  const app = createControlPlaneServer({ db, r2, sessionRegistry, queue, env });
  await app.listen({ port: env.CONTROL_PLANE_PORT, host: "0.0.0.0" });
  log.info("started", {
    port: env.CONTROL_PLANE_PORT,
    maxConcurrent: env.BOT_MAX_CONCURRENT,
  });

  const shutdown = async (signal: string): Promise<void> => {
    log.info("shutdown_requested", { signal });
    stopReaper();
    await app.close();
    await queue.close().catch(() => undefined);
    await sql.end({ timeout: 5 });
    await connection.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
