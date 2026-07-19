import "fastify";
import type { OAuth2Namespace } from "@fastify/oauth2";
import type { Db } from "../db/client.js";
import type { Env } from "../config.js";
import type { R2 } from "../lib/r2.js";
import type { EmailSender } from "../lib/email.js";
import type { Embedder } from "../lib/embeddings.js";
import type { ChatBackend } from "../lib/chat.js";
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
    // Null when RESEND_API_KEY isn't configured (summary-email route 503).
    email: EmailSender | null;
    // Ticket 3.6: always present — no API key needed for query-time
    // embedding (in-process transformers.js, D64).
    embedder: Embedder;
    // Null when GROQ_API_KEY isn't configured (/chat route 503).
    chat: ChatBackend | null;
    queue: Queue;
    events: Events;
  }

  interface FastifyRequest {
    // Populated by fastify.authenticate; only present on protected routes.
    auth?: AuthContext;
  }
}
