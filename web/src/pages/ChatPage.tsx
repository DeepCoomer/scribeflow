import { useState } from "react";
import { streamChat, type ChatCitation } from "../api.js";

function fmtTs(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

type Turn = {
  query: string;
  answer: string;
  citations: ChatCitation[];
  error: string | null;
  streaming: boolean;
};

// Ticket 3.6: "ask your meetings" — retrieval-grounded chat over the
// tenant's transcript history, streamed token-by-token with numbered
// citations linking back to the transcript moment they came from.
export function ChatPage() {
  const [query, setQuery] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true);
    setQuery("");
    setTurns((prev) => [
      ...prev,
      { query: q, answer: "", citations: [], error: null, streaming: true },
    ]);

    await streamChat(q, {
      onCitations: (citations) => {
        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1]!, citations };
          return next;
        });
      },
      onToken: (text) => {
        setTurns((prev) => {
          const next = [...prev];
          const last = next[next.length - 1]!;
          next[next.length - 1] = { ...last, answer: last.answer + text };
          return next;
        });
      },
      onError: (message) => {
        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            ...next[next.length - 1]!,
            error: message,
            streaming: false,
          };
          return next;
        });
      },
      onDone: () => {
        setTurns((prev) => {
          const next = [...prev];
          next[next.length - 1] = { ...next[next.length - 1]!, streaming: false };
          return next;
        });
      },
    });
    setBusy(false);
  }

  return (
    <div>
      <h2>Ask your meetings</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        Answers are grounded in your team's transcripts, with numbered citations linking
        back to the exact moment.
      </p>

      <div style={{ display: "grid", gap: 20, marginTop: 16 }}>
        {turns.map((turn, i) => (
          <ChatTurn key={i} turn={turn} />
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask(query);
        }}
        style={{ display: "flex", gap: 8, marginTop: 20 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="What did we decide about the roadmap?"
          disabled={busy}
          style={{ flex: 1, padding: "8px 10px" }}
        />
        <button type="submit" disabled={busy || !query.trim()}>
          {busy ? "Asking…" : "Ask"}
        </button>
      </form>
    </div>
  );
}

function ChatTurn({ turn }: { turn: Turn }) {
  return (
    <div>
      <div style={{ fontWeight: 600 }}>{turn.query}</div>
      <div style={{ marginTop: 4, whiteSpace: "pre-wrap" }}>
        {turn.answer}
        {turn.streaming && <span style={{ opacity: 0.5 }}> ▍</span>}
      </div>
      {turn.error && <p style={{ color: "crimson" }}>{turn.error}</p>}
      {turn.citations.length > 0 && (
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            fontSize: 13,
          }}
        >
          {turn.citations.map((c) => (
            <a
              key={c.segmentId}
              href={`#/meetings/${c.meetingId}?segment=${c.segmentId}`}
              style={{ color: "#6b7280" }}
            >
              [{c.index}] {c.meetingTitle} @ {fmtTs(c.startS)}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
