import { useEffect, useState } from "react";
import {
  api,
  meetingEventsUrl,
  type ActionItem,
  type Followup,
  type Meeting,
  type MeetingSummary,
  type Segment,
  type SpeakerInfo,
} from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { SpeakerName } from "../components/SpeakerName.js";

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

// Ticket 3.2: a small color cue next to a segment, not a number — the exact
// score matters far less than "this got tense" at a glance.
const SENTIMENT_COLOR: Record<string, string> = {
  positive: "#16a34a",
  neutral: "#9ca3af",
  negative: "#dc2626",
};

// Tickets 1.5 (read-only transcript viewer) + 1.6 (live status via SSE) +
// 2.6 (speaker display names + inline rename) + 3.1/3.2/3.3/3.4 (summary,
// decisions, per-utterance sentiment, action items, approval-gated email).
export function MeetingDetailPage({
  id,
  initialSegmentId,
}: {
  id: string;
  initialSegmentId?: string | undefined;
}) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([]);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  const [actionItems, setActionItems] = useState<ActionItem[]>([]);
  const [followup, setFollowup] = useState<Followup | null>(null);
  const [followupDraft, setFollowupDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [sendingFollowup, setSendingFollowup] = useState(false);
  const [followupError, setFollowupError] = useState<string | null>(null);

  async function load() {
    try {
      const data = await api.transcript(id);
      setMeeting(data.meeting);
      setSegments(data.segments);
      setSpeakers(data.speakers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadIntelligence() {
    const [{ summary }, { actionItems }, { followup }] = await Promise.all([
      api.summary(id),
      api.meetingActionItems(id),
      api.followup(id),
    ]);
    setSummary(summary);
    setActionItems(actionItems);
    setFollowup(followup);
    // Only overwrite an in-progress edit if it hasn't diverged from the
    // last-loaded draft yet — an extraction refetch mid-edit shouldn't
    // clobber unsent changes the user is actively typing.
    setFollowupDraft((prev) => (prev === "" ? (followup?.body ?? "") : prev));
  }

  // Renaming updates every segment sharing that label at once, without a
  // refetch — the label is the stable key (D56), the display name is not.
  async function renameSpeaker(speakerLabel: string, displayName: string) {
    const updated = await api.renameSpeaker(id, speakerLabel, displayName);
    setSpeakers((prev) => {
      const next = prev.filter((s) => s.speakerLabel !== speakerLabel);
      next.push(updated);
      return next;
    });
  }

  async function toggleActionItemDone(item: ActionItem) {
    const status = item.status === "done" ? "open" : "done";
    const updated = await api.updateActionItem(id, item.id, { status });
    setActionItems((prev) =>
      prev.map((i) => (i.id === item.id ? { ...i, ...updated } : i)),
    );
  }

  async function sendSummaryEmail() {
    setSendingEmail(true);
    setEmailError(null);
    try {
      const { emailSentAt } = await api.sendSummaryEmail(id);
      setSummary((prev) => (prev ? { ...prev, emailSentAt } : prev));
    } catch (err) {
      setEmailError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingEmail(false);
    }
  }

  async function sendFollowup() {
    setSendingFollowup(true);
    setFollowupError(null);
    try {
      const { sentAt } = await api.sendFollowup(id, followupDraft);
      setFollowup({ body: followupDraft, sentAt });
    } catch (err) {
      setFollowupError(err instanceof Error ? err.message : String(err));
    } finally {
      setSendingFollowup(false);
    }
  }

  const nameByLabel = new Map(speakers.map((s) => [s.speakerLabel, s.displayName]));

  useEffect(() => {
    void load();
    void loadIntelligence();
    const url = meetingEventsUrl(id);
    if (!url) return;
    const source = new EventSource(url);
    source.addEventListener("status", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as {
        status: Meeting["status"];
        error: string | null;
      };
      setMeeting((prev) =>
        prev ? { ...prev, status: data.status, error: data.error } : prev,
      );
      // Terminal states carry the finished transcript — refetch once.
      if (
        data.status === "done" ||
        data.status === "partial" ||
        data.status === "failed"
      ) {
        void load();
      }
    });
    // 3.1/3.2: extraction never changes meeting.status, so it gets its own
    // event — refetch the summary/action items/sentiment when it lands.
    source.addEventListener("extraction", () => {
      void loadIntelligence();
      void load();
    });
    return () => source.close();
  }, [id]);

  useEffect(() => {
    if (!initialSegmentId || segments.length === 0) return;
    document
      .getElementById(`segment-${initialSegmentId}`)
      ?.scrollIntoView({ block: "center" });
  }, [initialSegmentId, segments]);

  if (error) return <p style={{ color: "crimson" }}>{error}</p>;
  if (!meeting) return <p>Loading…</p>;

  const live = meeting.status === "processing" || meeting.status === "transcribing";
  return (
    <div>
      <p>
        <a href="#/">&larr; All meetings</a>
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <h2 style={{ margin: 0 }}>{meeting.title}</h2>
        <StatusBadge status={meeting.status} />
      </div>
      {meeting.durationS !== null && (
        <p style={{ color: "#666" }}>Duration: {fmtTime(meeting.durationS)}</p>
      )}
      {meeting.error && <p style={{ color: "crimson" }}>{meeting.error}</p>}
      {live && <p style={{ color: "#666" }}>Transcribing… this page updates live.</p>}

      {summary && (
        <div
          style={{
            marginTop: 16,
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "10px 14px",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Summary</h3>
          <p>{summary.summary}</p>
          {summary.decisions.length > 0 && (
            <>
              <strong>Decisions</strong>
              <ul>
                {summary.decisions.map((d, i) => (
                  <li key={i}>{d.text}</li>
                ))}
              </ul>
            </>
          )}
          <button onClick={() => void sendSummaryEmail()} disabled={sendingEmail}>
            {summary.emailSentAt
              ? `Sent ${new Date(summary.emailSentAt).toLocaleString()} — resend`
              : sendingEmail
                ? "Sending…"
                : "Send summary to my email"}
          </button>
          {emailError && <p style={{ color: "crimson" }}>{emailError}</p>}
        </div>
      )}

      {actionItems.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3>Action items</h3>
          <div style={{ display: "grid", gap: 6 }}>
            {actionItems.map((item) => (
              <label
                key={item.id}
                style={{ display: "flex", gap: 8, alignItems: "flex-start" }}
              >
                <input
                  type="checkbox"
                  checked={item.status === "done"}
                  onChange={() => void toggleActionItemDone(item)}
                />
                <span
                  style={{
                    textDecoration: item.status === "done" ? "line-through" : "none",
                  }}
                >
                  {item.text}
                  {item.ownerName && (
                    <span style={{ color: "#6b7280" }}> — {item.ownerName}</span>
                  )}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {followup && (
        <div
          style={{
            marginTop: 16,
            border: "1px solid #e5e7eb",
            borderRadius: 8,
            padding: "10px 14px",
          }}
        >
          <h3 style={{ marginTop: 0 }}>Follow-up email</h3>
          <p style={{ color: "#666", fontSize: 13, marginTop: 0 }}>
            Drafted from the summary and action items above, grouped by owner — edit
            before sending; it's never sent automatically.
          </p>
          <textarea
            value={followupDraft}
            onChange={(e) => setFollowupDraft(e.target.value)}
            rows={10}
            style={{ width: "100%", fontFamily: "inherit", padding: 8 }}
          />
          <div style={{ marginTop: 8 }}>
            <button
              onClick={() => void sendFollowup()}
              disabled={sendingFollowup || !followupDraft.trim()}
            >
              {followup.sentAt
                ? `Sent ${new Date(followup.sentAt).toLocaleString()} — resend`
                : sendingFollowup
                  ? "Sending…"
                  : "Send follow-up to my email"}
            </button>
          </div>
          {followupError && <p style={{ color: "crimson" }}>{followupError}</p>}
        </div>
      )}

      {segments.length > 0 && (
        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          {segments.map((seg) => (
            <div
              key={seg.id}
              id={`segment-${seg.id}`}
              style={{
                display: "flex",
                gap: 12,
                background:
                  seg.id === initialSegmentId ? "rgba(59, 130, 246, 0.08)" : undefined,
                borderRadius: 6,
              }}
            >
              <span
                style={{
                  color: "#9ca3af",
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 48,
                }}
              >
                {fmtTime(seg.startS)}
              </span>
              {seg.sentimentLabel && (
                <span
                  title={`sentiment: ${seg.sentimentLabel}`}
                  style={{ color: SENTIMENT_COLOR[seg.sentimentLabel] }}
                >
                  ●
                </span>
              )}
              <span>
                {seg.speaker && (
                  <>
                    <SpeakerName
                      displayName={nameByLabel.get(seg.speaker) ?? seg.speaker}
                      onRename={(name) => void renameSpeaker(seg.speaker!, name)}
                    />
                    {": "}
                  </>
                )}
                {!seg.speaker && <em style={{ color: "#9ca3af" }}>Unknown: </em>}
                {seg.text}
              </span>
            </div>
          ))}
        </div>
      )}
      {segments.length === 0 && meeting.status === "done" && (
        <p style={{ color: "#666" }}>The transcript is empty (silent recording?).</p>
      )}
    </div>
  );
}
