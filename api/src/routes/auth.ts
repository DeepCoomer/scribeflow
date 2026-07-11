import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { createTenant, findTenantBySlug } from "../db/repositories/tenants.js";
import {
  createUser,
  findUserByEmail,
  findUserByGoogleId,
} from "../db/repositories/users.js";

const registerSchema = z.object({
  tenantName: z.string().min(2).max(100),
  name: z.string().min(1).max(100),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  return base || "team";
}

async function uniqueSlug(app: FastifyInstance, name: string): Promise<string> {
  const base = slugify(name);
  if (!(await findTenantBySlug(app.db, base))) return base;
  return `${base}-${randomBytes(3).toString("hex")}`;
}

export default async function authRoutes(app: FastifyInstance) {
  // Registration doubles as tenant creation for v1: the first user of a new
  // team signs up and becomes its owner. Invite-based joins are a later
  // ticket (out of scope for 0.5) — see docs/plan.md.
  app.post("/auth/register", async (request, reply) => {
    const body = registerSchema.parse(request.body);

    if (await findUserByEmail(app.db, body.email)) {
      return reply.conflict("An account with that email already exists");
    }

    const slug = await uniqueSlug(app, body.tenantName);
    const tenant = await createTenant(app.db, { name: body.tenantName, slug });
    const passwordHash = await app.hashPassword(body.password);
    const user = await createUser(app.db, {
      tenantId: tenant.id,
      email: body.email,
      name: body.name,
      role: "owner",
      passwordHash,
    });

    const token = app.issueToken({
      userId: user.id,
      tenantId: tenant.id,
      role: user.role,
    });
    return reply.code(201).send({ token });
  });

  app.post("/auth/login", async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await findUserByEmail(app.db, body.email);
    if (!user || !user.passwordHash) {
      return reply.unauthorized("Invalid email or password");
    }

    const valid = await app.verifyPassword(user.passwordHash, body.password);
    if (!valid) {
      return reply.unauthorized("Invalid email or password");
    }

    const token = app.issueToken({
      userId: user.id,
      tenantId: user.tenantId,
      role: user.role,
    });
    return { token };
  });

  // Google OAuth is only wired up when credentials are configured (see
  // app.ts) — @fastify/oauth2 registers /auth/google itself; this route is
  // just the callback that exchanges the code and issues our own JWT.
  if (app.config.GOOGLE_OAUTH_CLIENT_ID) {
    app.get("/auth/google/callback", async (request, reply) => {
      const { token: googleToken } =
        await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

      const profileRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
        headers: { Authorization: `Bearer ${googleToken.access_token}` },
      });
      if (!profileRes.ok) {
        return reply.badGateway("Failed to fetch Google profile");
      }
      const profile = (await profileRes.json()) as {
        sub: string;
        email: string;
        name: string;
      };

      let user = await findUserByGoogleId(app.db, profile.sub);
      if (!user) {
        const existingByEmail = await findUserByEmail(app.db, profile.email);
        if (existingByEmail) {
          return reply.conflict(
            "An account with that email already exists; log in with a password instead",
          );
        }
        const slug = await uniqueSlug(app, profile.name);
        const tenant = await createTenant(app.db, { name: profile.name, slug });
        user = await createUser(app.db, {
          tenantId: tenant.id,
          email: profile.email,
          name: profile.name,
          role: "owner",
          googleId: profile.sub,
        });
      }

      const token = app.issueToken({
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
      });
      return { token };
    });
  }
}
