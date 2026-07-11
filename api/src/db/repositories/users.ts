import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { users } from "../schema.js";
import { firstOrThrow } from "../util.js";

export type NewUser = {
  tenantId: string;
  email: string;
  name: string;
  role?: "owner" | "admin" | "member";
  passwordHash?: string | null;
  googleId?: string | null;
};

export async function createUser(db: Db, input: NewUser) {
  const rows = await db.insert(users).values(input).returning();
  return firstOrThrow(rows, "user");
}

// No tenantId parameter: these two run during the login/OAuth handshake,
// before a tenant is known — that's the request's whole purpose, not a
// data leak. Every other lookup in this file requires tenantId (D20).
export async function findUserByEmail(db: Db, email: string) {
  const [user] = await db.select().from(users).where(eq(users.email, email));
  return user ?? null;
}

export async function findUserByGoogleId(db: Db, googleId: string) {
  const [user] = await db.select().from(users).where(eq(users.googleId, googleId));
  return user ?? null;
}

export async function findUserById(db: Db, tenantId: string, userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)));
  return user ?? null;
}
