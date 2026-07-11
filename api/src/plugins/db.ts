import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { createDb } from "../db/client.js";

// Depends on plugins/config.ts having decorated app.config already
// (registration order in app.ts enforces this).
export default fp(async function dbPlugin(app: FastifyInstance) {
  const db = createDb(app.config);
  app.decorate("db", db);
});
