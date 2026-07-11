import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.js";
import type { Env } from "../config.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(env: Env) {
  const client = postgres(env.DATABASE_URL);
  return drizzle(client, { schema });
}
