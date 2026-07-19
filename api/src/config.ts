import "dotenv/config";
import { z } from "zod";

// .env files express "unset" as `VAR=` (empty string), which would fail
// stricter validators like .url() — normalize to undefined first.
const optionalUrl = z.preprocess(
  (v) => (v === "" ? undefined : v),
  z.string().url().optional(),
);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_CALLBACK_URL: optionalUrl,
  RABBITMQ_URL: z.string().default("amqp://scribeflow:scribeflow@localhost:5672"),
  // R2 credentials are optional so the API can boot without object storage
  // (health checks, auth-only work); the upload endpoints 503 until they're
  // set. R2_ENDPOINT overrides the derived Cloudflare endpoint for tests /
  // S3-compatible stand-ins.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().default("scribeflow"),
  R2_ENDPOINT: optionalUrl,
  UPLOAD_URL_TTL_S: z.coerce.number().int().positive().default(900),
  // Comma-separated allowed browser origins (the Vite dev server locally,
  // the Vercel dashboard in production).
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  // Ticket 3.4: optional (D22-style fallback — "or skip" per plan.md). Unset
  // means the summary-email endpoint 503s, same pattern as R2 above.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z
    .string()
    .default("ScribeFlow <notifications@scribeflow.deepcoomer.dev>"),
  // Ticket 3.6 (D64): the RAG chat's answer step (retrieval itself needs no
  // API key — pgvector + the in-process transformers.js query embedder).
  // Same account/key as the workers' extraction pass, but its own env var
  // here since the API and the Python workers don't share a process — unset
  // means the chat endpoint 503s, same "optional, or skip" pattern as
  // RESEND_API_KEY/R2 above.
  GROQ_API_KEY: z.string().optional(),
  GROQ_LLM_MODEL: z.string().default("llama-3.3-70b-versatile"),
  // Ticket 3.6 (D64): must stay the transformers.js/ONNX twin of the
  // workers' EMBEDDING_MODEL (workers/.env.example) — same weights,
  // different runtime — or query vectors land in a different space than
  // the stored document vectors.
  EMBEDDING_QUERY_MODEL: z.string().default("Xenova/all-MiniLM-L6-v2"),
});

export type Env = z.infer<typeof envSchema>;

// Fails fast on boot with a readable diff instead of surfacing as a random
// runtime error the first time a bad/missing var is touched.
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    console.error(parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  return parsed.data;
}
