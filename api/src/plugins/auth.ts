import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import { hash, verify } from "@node-rs/argon2";
import type { FastifyInstance } from "fastify";
import type { AuthContext } from "../types/fastify.js";

// Owns password hashing and JWT issuance. Tenant-scoping enforcement (reading
// the token back into request.auth) lives in plugins/tenant.ts — kept
// separate so "how do we prove who you are" and "how do we scope what you
// can touch" stay independently testable.
export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(jwt, {
    secret: app.config.JWT_SECRET,
    sign: { expiresIn: "7d" },
  });

  app.decorate("hashPassword", (plain: string) => hash(plain));
  app.decorate("verifyPassword", (hash_: string, plain: string) => verify(hash_, plain));

  app.decorate("issueToken", (auth: AuthContext) => app.jwt.sign(auth));
});
