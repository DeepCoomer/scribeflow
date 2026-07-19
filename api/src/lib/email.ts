import type { Env } from "../config.js";

// Ticket 3.4: Resend's HTTP API is a single POST, so a full SDK dependency
// buys nothing here — same "only what's needed" reasoning as R2 skipping a
// hand-rolled S3 client. Mirrors lib/r2.ts's `| null` shape: missing
// credentials disable the feature (503) instead of crashing boot.

export type EmailSender = {
  send: (opts: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }) => Promise<void>;
};

export function createEmailSender(env: Env): EmailSender | null {
  if (!env.RESEND_API_KEY) return null;
  const from = env.RESEND_FROM_EMAIL;

  return {
    async send({ to, subject, text, html }) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RESEND_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ from, to, subject, text, html }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Resend send failed: ${res.status} ${body}`);
      }
    },
  };
}
