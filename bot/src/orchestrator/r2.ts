import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "./config.js";

// Presigned-URL minting only (D7/D70) — the orchestrator signs, the bot
// container PUTs straight to R2, and the bot never holds an R2 credential.
// Mirrors api/src/lib/r2.ts.

export type R2 = {
  presignPut: (key: string, contentType: string, expiresInS: number) => Promise<string>;
};

export function createR2(env: Env): R2 | null {
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) return null;
  const endpoint =
    env.R2_ENDPOINT ??
    (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null);
  if (!endpoint) return null;

  const client = new S3Client({
    region: "auto",
    endpoint,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
  });

  return {
    presignPut: (key, contentType, expiresInS) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          ContentType: contentType,
        }),
        { expiresIn: expiresInS },
      ),
  };
}

export function botSegmentKey(
  tenantId: string,
  meetingId: string,
  idx: number,
  startedAtMs: number,
): string {
  return `tenant/${tenantId}/meeting/${meetingId}/bot-segments/${idx}_${startedAtMs}.ogg`;
}

export function botDebugKey(tenantId: string, meetingId: string, name: string): string {
  return `tenant/${tenantId}/meeting/${meetingId}/bot-debug/${name}`;
}
