import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Env } from "../config.js";

// Presigned-URL minting only (D7): the API signs, the client PUTs straight
// to R2, and no media byte ever crosses this process. Signing is pure local
// crypto — no network call — which is also what makes it unit-testable with
// fake credentials.

export type R2 = {
  bucket: string;
  presignPut: (opts: {
    key: string;
    contentType: string;
    contentLength: number;
    expiresInS: number;
  }) => Promise<string>;
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
    bucket: env.R2_BUCKET,
    // Content type and length are part of the signature: the URL is only
    // good for the exact upload the caller declared, nothing bigger.
    presignPut: ({ key, contentType, contentLength, expiresInS }) =>
      getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          ContentType: contentType,
          ContentLength: contentLength,
        }),
        { expiresIn: expiresInS },
      ),
  };
}
