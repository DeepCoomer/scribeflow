import "fastify";
import type { OAuth2Namespace } from "@fastify/oauth2";
import type { Db } from "../db/client.js";
import type { Env } from "../config.js";
import type { R2 } from "../lib/r2.js";
import type { Queue } from "../plugins/queue.js";
import type { Events } from "../plugins/events.js";

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
    // Null when R2 credentials aren't configured (upload routes 503).
    r2: R2 | null;
    queue: Queue;
    events: Events;
  }

  interface FastifyRequest {
    // Populated by fastify.authenticate; only present on protected routes.
    auth?: AuthContext;
  }
}
