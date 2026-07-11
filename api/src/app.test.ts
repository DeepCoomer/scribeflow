import { describe, it, expect } from "vitest";
import { loadEnv } from "./config.js";
import { buildApp } from "./app.js";

// Integration test: exercises health, register, login, and the tenant
// middleware together against a real Postgres (see docs/infrastructure.md /
// CI workflow). Requires DATABASE_URL with migrations already applied —
// `pnpm db:migrate` locally, or the CI Postgres service.
const env = loadEnv();

describe("api", () => {
  it("GET /health returns ok without touching the db", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });

  it("register -> login -> /me round-trip stays scoped to one tenant", async () => {
    const app = await buildApp(env);
    const email = `test-${Date.now()}@example.com`;

    const registerRes = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: {
        tenantName: "Acme Test Co",
        name: "Ada Test",
        email,
        password: "correct-horse-battery-staple",
      },
    });
    expect(registerRes.statusCode).toBe(201);
    const { token } = registerRes.json();
    expect(typeof token).toBe("string");

    const meRes = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json();
    expect(me.email).toBe(email);
    expect(me.role).toBe("owner");

    const loginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "correct-horse-battery-staple" },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(typeof loginRes.json().token).toBe("string");

    const badLoginRes = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email, password: "wrong-password" },
    });
    expect(badLoginRes.statusCode).toBe(401);

    await app.close();
  });

  it("rejects /me with no token", async () => {
    const app = await buildApp(env);
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
