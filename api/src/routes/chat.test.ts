import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadEnv } from "../config.js";
import { buildApp } from "../app.js";
import { transcriptSegments } from "../db/schema.js";
import type { Embedder } from "../lib/embeddings.js";
import type { ChatBackend } from "../lib/chat.js";

// Integration tests for ticket 3.6 (D64): needs the compose Postgres
// (migrated through 0006, pgvector) up — same prerequisites as `pnpm test`
// documents. The embedder and chat backend are stubbed (no ONNX model load,
// no live Groq call, per CLAUDE.md test conventions) by overriding the
// decorations buildApp() installs — same "fake credentials, offline" shape
// meetings.test.ts uses for R2.
const env = { ...loadEnv() };

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let token: string;

function onehot(dim: number, index: number): number[] {
  return Array.from({ length: dim }, (_, i) => (i === index ? 1 : 0));
}

async function registerUser(a: App, email: string) {
  const res = await a.inject({
    method: "POST",
    url: "/auth/register",
    payload: {
      tenantName: "Chat Test Co",
      name: "Pat Test",
      email,
      password: "correct-horse-battery-staple",
    },
  });
  expect(res.statusCode).toBe(201);
  const t = res.json().token as string;
  const payload = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString());
  return { token: t, tenantId: payload.tenantId as string };
}

beforeAll(async () => {
  app = await buildApp(env);
  ({ token } = await registerUser(app, `chat-${Date.now()}@example.com`));
  await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
  await app.close();
});

async function postChat(query: string) {
  const address = app.server.address();
  if (typeof address !== "object" || address === null) throw new Error("no address");
  const res = await fetch(`http://127.0.0.1:${address.port}/chat`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  return res;
}

async function readSseEvents(
  res: Response,
): Promise<Array<{ event: string; data: unknown }>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith(":")) continue; // comment/heartbeat
      const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice("event: ".length);
      events.push({ event, data: JSON.parse(dataLine.slice("data: ".length)) });
      if (event === "done") return events;
    }
  }
  return events;
}

describe("/chat (3.6, D64)", () => {
  it("503s when GROQ_API_KEY isn't configured", async () => {
    const original = app.chat;
    app.chat = null;
    try {
      const res = await postChat("what did we decide?");
      expect(res.status).toBe(503);
    } finally {
      app.chat = original;
    }
  });

  it("retrieves the closest segments and streams a token-by-token answer with citations", async () => {
    const meetingRes = await app.inject({
      method: "POST",
      url: "/meetings",
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Roadmap sync" },
    });
    const meetingId = meetingRes.json().id as string;

    await app.db.insert(transcriptSegments).values([
      {
        meetingId,
        chunkIdx: 0,
        startS: 12.0,
        endS: 16.0,
        text: "We decided to ship the roadmap on Friday.",
        embedding: onehot(384, 0),
      },
      {
        meetingId,
        chunkIdx: 0,
        startS: 40.0,
        endS: 44.0,
        text: "Lunch is at noon.",
        embedding: onehot(384, 1),
      },
    ]);

    const fakeEmbedder: Embedder = { embed: async () => onehot(384, 0) };
    const fakeChat: ChatBackend = {
      async *streamAnswer() {
        yield "Ship";
        yield "ping Friday [1].";
      },
    };
    const originalEmbedder = app.embedder;
    const originalChat = app.chat;
    app.embedder = fakeEmbedder;
    app.chat = fakeChat;

    try {
      const res = await postChat("when are we shipping?");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const events = await readSseEvents(res);
      const citations = events.find((e) => e.event === "citations")!.data as Array<{
        meetingId: string;
        startS: number;
        index: number;
      }>;
      // The exact-match segment (one-hot index 0) ranks first.
      expect(citations[0]).toMatchObject({ meetingId, startS: 12 });
      expect(citations.map((c) => c.index)).toEqual([1, 2]);

      const tokens = events
        .filter((e) => e.event === "token")
        .map((e) => (e.data as { text: string }).text)
        .join("");
      expect(tokens).toBe("Shipping Friday [1].");

      expect(events.some((e) => e.event === "done")).toBe(true);
    } finally {
      app.embedder = originalEmbedder;
      app.chat = originalChat;
    }
  });

  it("skips the LLM and returns a graceful message when nothing matches", async () => {
    const fakeChat: ChatBackend = {
      streamAnswer: () => {
        throw new Error("should not be called");
      },
    };
    const originalEmbedder = app.embedder;
    const originalChat = app.chat;
    // No segments at all belong to this fresh tenant.
    const { token: otherToken } = await registerUser(
      app,
      `chat-empty-${Date.now()}@example.com`,
    );
    app.embedder = { embed: async () => onehot(384, 0) };
    app.chat = fakeChat;

    try {
      const address = app.server.address();
      if (typeof address !== "object" || address === null) throw new Error("no address");
      const res = await fetch(`http://127.0.0.1:${address.port}/chat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${otherToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query: "anything?" }),
      });
      const events = await readSseEvents(res);
      expect(events.find((e) => e.event === "citations")!.data).toEqual([]);
      const tokenEvent = events.find((e) => e.event === "token")!;
      expect((tokenEvent.data as { text: string }).text).toMatch(/couldn't find/);
    } finally {
      app.embedder = originalEmbedder;
      app.chat = originalChat;
    }
  });
});
