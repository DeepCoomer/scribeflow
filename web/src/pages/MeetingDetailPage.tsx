import { useEffect, useState } from "react";
import {
  api,
  meetingEventsUrl,
  type Meeting,
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

// Tickets 1.5 (read-only transcript viewer) + 1.6 (live status via SSE) +
// 2.6 (speaker display names + inline rename).
export function MeetingDetailPage({ id }: { id: string }) {
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [speakers, setSpeakers] = useState<SpeakerInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

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

  const nameByLabel = new Map(speakers.map((s) => [s.speakerLabel, s.displayName]));

  useEffect(() => {
    void load();
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
    return () => source.close();
  }, [id]);

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

      {segments.length > 0 && (
        <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
          {segments.map((seg) => (
            <div key={seg.id} style={{ display: "flex", gap: 12 }}>
              <span
                style={{
                  color: "#9ca3af",
                  fontVariantNumeric: "tabular-nums",
                  minWidth: 48,
                }}
              >
                {fmtTime(seg.startS)}
              </span>
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
