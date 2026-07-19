import Groq from "groq-sdk";
import type { Env } from "../config.js";

// Ticket 3.6 (D64): the RAG chat's answer step, streamed token-by-token so
// the API can forward it over SSE as it arrives rather than waiting for the
// full completion. Mirrors email.ts's `| null` shape: missing credentials
// disable the feature (503) instead of crashing boot.

export type ChatBackend = {
  streamAnswer: (opts: {
    systemPrompt: string;
    userPrompt: string;
  }) => AsyncIterable<string>;
};

export function createChatBackend(env: Env): ChatBackend | null {
  if (!env.GROQ_API_KEY) return null;
  const client = new Groq({ apiKey: env.GROQ_API_KEY });
  const model = env.GROQ_LLM_MODEL;

  return {
    async *streamAnswer({ systemPrompt, userPrompt }) {
      const stream = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        stream: true,
      });
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) yield delta;
      }
    },
  };
}
