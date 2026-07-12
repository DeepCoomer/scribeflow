import Fastify from "fastify";
import sensible from "@fastify/sensible";
import cors from "@fastify/cors";
import oauth2 from "@fastify/oauth2";
import type { Env } from "./config.js";
import configPlugin from "./plugins/config.js";
import dbPlugin from "./plugins/db.js";
import authPlugin from "./plugins/auth.js";
import tenantPlugin from "./plugins/tenant.js";
import queuePlugin from "./plugins/queue.js";
import eventsPlugin from "./plugins/events.js";
import { createR2 } from "./lib/r2.js";
import healthRoutes from "./routes/health.js";
import authRoutes from "./routes/auth.js";
import meRoutes from "./routes/me.js";
import meetingRoutes from "./routes/meetings.js";

// pino's transport option is only valid when present at all — passing
// `transport: undefined` trips exactOptionalPropertyTypes, so it's built
// conditionally instead of assigned a possibly-undefined value.
function loggerOptions(env: Env) {
  const level = env.NODE_ENV === "test" ? "silent" : "info";
  if (env.NODE_ENV !== "development") return { level };
  return { level, transport: { target: "pino-pretty" } };
}

export async function buildApp(env: Env) {
  const app = Fastify({ logger: loggerOptions(env) });

  // Order matters: config before db/auth (both read app.config), tenant
  // after auth (it depends on @fastify/jwt being registered), events after
  // queue (it attaches to the queue's fanout consumer).
  await app.register(configPlugin, env);
  await app.register(sensible);
  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(",").map((o) => o.trim()),
  });
  await app.register(dbPlugin);
  await app.register(authPlugin);
  await app.register(tenantPlugin);
  await app.register(queuePlugin);
  await app.register(eventsPlugin);
  app.decorate("r2", createR2(env));
  if (!app.r2) {
    app.log.warn("R2 credentials not set — upload endpoints disabled (503)");
  }

  if (env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET) {
    await app.register(oauth2, {
      name: "googleOAuth2",
      scope: ["openid", "email", "profile"],
      credentials: {
        client: {
          id: env.GOOGLE_OAUTH_CLIENT_ID,
          secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        },
        // Equivalent to @fastify/oauth2's GOOGLE_CONFIGURATION constant,
        // inlined because its .d.ts doesn't expose that static property on
        // the default export under esModuleInterop (a gap in their types,
        // not ours) — these are Google's stable public OAuth endpoints.
        auth: {
          authorizeHost: "https://accounts.google.com",
          authorizePath: "/o/oauth2/v2/auth",
          tokenHost: "https://www.googleapis.com",
          tokenPath: "/oauth2/v4/token",
        },
      },
      startRedirectPath: "/auth/google",
      callbackUri:
        env.GOOGLE_OAUTH_CALLBACK_URL ?? "http://localhost:3000/auth/google/callback",
    });
  } else {
    app.log.warn("GOOGLE_OAUTH_CLIENT_ID not set — Google sign-in disabled");
  }

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(meRoutes);
  await app.register(meetingRoutes);

  return app;
}
