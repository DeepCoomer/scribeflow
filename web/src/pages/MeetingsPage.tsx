import { useEffect, useRef, useState } from "react";
import { api, putToPresignedUrl, type Meeting } from "../api.js";
import { StatusBadge } from "../components/StatusBadge.js";

// Ticket 1.1's client half: pick a file → create meeting → presigned PUT
// straight to R2 → mark uploaded (which enqueues the pipeline job).
export function MeetingsPage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    try {
      const { meetings } = await api.listMeetings();
      setMeetings(meetings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function onFilePicked(file: File) {
    setError(null);
    try {
      const title = file.name.replace(/\.[^.]+$/, "");
      setUploading(`Creating “${title}”…`);
      const meeting = await api.createMeeting(title);
      const { url } = await api.uploadUrl(meeting.id, file.type, file.size);
      setUploading(`Uploading ${file.name}…`);
      await putToPresignedUrl(url, file);
      await api.markUploaded(meeting.id);
      window.location.hash = `#/meetings/${meeting.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      setUploading(null);
    }
  }

  return (
    <div>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
      >
        <h2>Meetings</h2>
        <div>
          <input
            ref={fileInput}
            type="file"
            accept="audio/*"
            style={{ display: "none" }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFilePicked(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            disabled={uploading !== null}
          >
            {uploading ?? "Upload a recording"}
          </button>
        </div>
      </div>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {meetings.length === 0 && !error && (
        <p style={{ color: "#666" }}>
          No meetings yet — upload an audio recording to see the pipeline run.
        </p>
      )}
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {meetings.map((m) => (
          <li
            key={m.id}
            style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: "10px 14px" }}
          >
            <a
              href={`#/meetings/${m.id}`}
              style={{
                textDecoration: "none",
                color: "inherit",
                display: "flex",
                justifyContent: "space-between",
              }}
            >
              <span>{m.title}</span>
              <StatusBadge status={m.status} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
