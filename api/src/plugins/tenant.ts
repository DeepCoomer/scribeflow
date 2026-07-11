import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../types/fastify.js";

// The tenant middleware (ticket 0.5): verifies the JWT and attaches
// request.auth. Every protected route handler must read tenantId from here
// and pass it explicitly into repository calls (D20) — there is no global
// "current tenant" to fall back on.
export default fp(async function tenantPlugin(app: FastifyInstance) {
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await request.jwtVerify<AuthContext>();
      request.auth = payload;
    } catch {
      return reply.unauthorized("Missing or invalid token");
    }
  });
});
