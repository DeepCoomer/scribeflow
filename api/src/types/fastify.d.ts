import "fastify";
import type { OAuth2Namespace } from "@fastify/oauth2";
import type { Db } from "../db/client.js";
import type { Env } from "../config.js";

export type AuthContext = {
  userId: string;
  tenantId: string;
  role: "owner" | "admin" | "member";
};

declare module "fastify" {
  interface FastifyInstance {
    config: Env;
    db: Db;
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    hashPassword: (plain: string) => Promise<string>;
    verifyPassword: (hash: string, plain: string) => Promise<boolean>;
    issueToken: (auth: AuthContext) => string;
    // Only present when GOOGLE_OAUTH_CLIENT_ID is configured (see app.ts).
    googleOAuth2: OAuth2Namespace;
  }

  interface FastifyRequest {
    // Populated by fastify.authenticate; only present on protected routes.
    auth?: AuthContext;
  }
}
