import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { Env } from "../config.js";

// Registered first; every other plugin reads app.config instead of
// touching process.env directly, so env access has one call site (config.ts)
// and one shape (Env) across the whole API.
export default fp(async function configPlugin(app: FastifyInstance, env: Env) {
  app.decorate("config", env);
});
