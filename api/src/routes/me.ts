import type { FastifyInstance } from "fastify";
import { findUserById } from "../db/repositories/users.js";

// Exists to prove the tenant middleware works end-to-end: a valid JWT for
// tenant A can never resolve a user row from tenant B, because tenantId
// comes from the verified token, not from the request body/params.
export default async function meRoutes(app: FastifyInstance) {
  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const { userId, tenantId } = request.auth!;
    const user = await findUserById(app.db, tenantId, userId);
    if (!user) return reply.notFound();
    return {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      name: user.name,
      role: user.role,
    };
  });
}
