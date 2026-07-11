import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { tenants } from "../schema.js";
import { firstOrThrow } from "../util.js";

export async function createTenant(db: Db, input: { name: string; slug: string }) {
  const rows = await db.insert(tenants).values(input).returning();
  return firstOrThrow(rows, "tenant");
}

export async function findTenantBySlug(db: Db, slug: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.slug, slug));
  return tenant ?? null;
}
