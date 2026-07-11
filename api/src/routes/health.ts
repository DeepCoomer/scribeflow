import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/health/db", async (_request, reply) => {
    try {
      await app.db.execute(sql`select 1`);
      return { status: "ok" };
    } catch (err) {
      app.log.error(err, "database health check failed");
      return reply.serviceUnavailable("database unreachable");
    }
  });
}
