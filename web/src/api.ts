// Thin typed client over the ScribeFlow API. The JWT lives in localStorage —
// acceptable for the v1 portfolio dashboard; revisit alongside ticket 7.2.

const BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const TOKEN_KEY = "scribeflow.token";

export type Meeting = {
  id: string;
  title: string;
  status:
    | "pending"
    | "uploading"
    | "processing"
    | "transcribing"
    | "partial"
    | "done"
    | "failed";
  startedAt: string | null;
  durationS: number | null;
  error: string | null;
  createdAt: string;
};

export type Segment = {
  id: string;
  chunkIdx: number;
  speaker: string | null;
  startS: number;
  endS: number;
  text: string;
  // Ticket 3.2: null until the extractor's batched sentiment pass runs.
  sentimentLabel: "positive" | "neutral" | "negative" | null;
  sentimentScore: number | null;
};

// Ticket 3.1: null until the extractor has run for this meeting.
export type MeetingSummary = {
  summary: string;
  decisions: { text: string; source_ts_s: number | null }[];
  model: string;
  emailSentAt: string | null;
};

// Ticket 3.7: null until a summary exists to draft from (D65).
export type Followup = {
  body: string;
  sentAt: string | null;
};

// Ticket 3.1/3.3: the LLM-extracted text/ownerName/confidence are read-only;
// status/ownerUserId/dueDate are the human-editable "assign, mark done" bits.
export type ActionItem = {
  id: string;
  meetingId: string;
  meetingTitle?: string; // present only on the tenant-wide list
  text: string;
  ownerName: string | null;
  ownerUserId: string | null;
  dueDate: string | null;
  confidence: number | null;
  status: "open" | "done" | "dismissed";
  sourceSegmentId: string | null;
  createdAt: string;
};

// Ticket 2.6: transcript_segments.speaker is the raw diarization label
// (SPEAKER_00, ...); this is the label -> human-name map (D56).
export type SpeakerInfo = {
  speakerLabel: string;
  displayName: string;
  userId: string | null;
  source: "default" | "user" | "calendar" | "voiceprint";
};

// Ticket 3.6: one retrieved excerpt backing a chat answer, in the numbered
// order the LLM was told to cite ([1], [2], ...) — see api/src/routes/chat.ts.
export type ChatCitation = {
  index: number;
  meetingId: string;
  meetingTitle: string;
  segmentId: string;
  startS: number;
};

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

// Ticket 3.3's "assign" action needs the caller's own user id for an
// "assign to me" control; there's no tenant user-directory endpoint yet
// (that's a Phase 6+ feature), so this decodes it straight out of the JWT
// already sitting in localStorage rather than adding one for a single field.
export function getCurrentUserId(): string | null {
  const token = getToken();
  if (!token) return null;
  try {
    const b64 = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(padded));
    return typeof payload.userId === "string" ? payload.userId : null;
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const token = getToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    setToken(null);
    window.location.hash = "#/login";
    throw new Error("Session expired, log in again");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  register: (input: {
    tenantName: string;
    name: string;
    email: string;
    password: string;
  }) =>
    request<{ token: string }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  login: (input: { email: string; password: string }) =>
    request<{ token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    }),

  listMeetings: () => request<{ meetings: Meeting[] }>("/meetings"),

  getMeeting: (id: string) => request<Meeting>(`/meetings/${id}`),

  createMeeting: (title: string) =>
    request<Meeting>("/meetings", { method: "POST", body: JSON.stringify({ title }) }),

  uploadUrl: (id: string, contentType: string, sizeBytes: number) =>
    request<{ url: string; key: string }>(`/meetings/${id}/upload-url`, {
      method: "POST",
      body: JSON.stringify({ contentType, sizeBytes }),
    }),

  markUploaded: (id: string) =>
    request<Meeting>(`/meetings/${id}/uploaded`, {
      method: "POST",
      body: JSON.stringify({}),
    }),

  transcript: (id: string) =>
    request<{ meeting: Meeting; segments: Segment[]; speakers: SpeakerInfo[] }>(
      `/meetings/${id}/transcript`,
    ),

  renameSpeaker: (meetingId: string, speakerLabel: string, displayName: string) =>
    request<SpeakerInfo>(
      `/meetings/${meetingId}/speakers/${encodeURIComponent(speakerLabel)}`,
      { method: "PATCH", body: JSON.stringify({ displayName }) },
    ),

  summary: (meetingId: string) =>
    request<{ summary: MeetingSummary | null }>(`/meetings/${meetingId}/summary`),

  sendSummaryEmail: (meetingId: string) =>
    request<{ emailSentAt: string }>(`/meetings/${meetingId}/summary-email`, {
      method: "POST",
    }),

  followup: (meetingId: string) =>
    request<{ followup: Followup | null }>(`/meetings/${meetingId}/followup`),

  sendFollowup: (meetingId: string, body: string) =>
    request<{ sentAt: string }>(`/meetings/${meetingId}/followup-send`, {
      method: "POST",
      body: JSON.stringify({ body }),
    }),

  meetingActionItems: (meetingId: string) =>
    request<{ actionItems: ActionItem[] }>(`/meetings/${meetingId}/action-items`),

  listActionItems: () => request<{ actionItems: ActionItem[] }>("/action-items"),

  updateActionItem: (
    meetingId: string,
    itemId: string,
    patch: { status?: ActionItem["status"]; ownerUserId?: string | null },
  ) =>
    request<ActionItem>(`/meetings/${meetingId}/action-items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
};

// The upload itself goes browser → R2 with the presigned URL; the API never
// sees the bytes (D7).
export async function putToPresignedUrl(url: string, file: File): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "content-type": file.type },
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.statusText}`);
}

// EventSource can't set headers, so the JWT rides as ?token= (D44).
export function meetingEventsUrl(id: string): string | null {
  const token = getToken();
  if (!token) return null;
  return `${BASE}/meetings/${id}/events?token=${encodeURIComponent(token)}`;
}

export type ChatStreamHandlers = {
  onCitations?: (citations: ChatCitation[]) => void;
  onToken?: (text: string) => void;
  onDone?: () => void;
  onError?: (message: string) => void;
};

// Ticket 3.6: POST (not EventSource) since a free-text query doesn't fit
// safely/losslessly in a URL — see api/src/routes/chat.ts. Consuming
// "text/event-stream" only needs a fetch() ReadableStream reader, not the
// EventSource API specifically.
export async function streamChat(
  query: string,
  handlers: ChatStreamHandlers,
): Promise<void> {
  const token = getToken();
  const headers = new Headers({ "content-type": "application/json" });
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query }),
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    handlers.onError?.(body?.message ?? `${res.status} ${res.statusText}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.startsWith(":")) continue; // comment/heartbeat
      const eventLine = frame.split("\n").find((l) => l.startsWith("event: "));
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!eventLine || !dataLine) continue;
      const event = eventLine.slice("event: ".length);
      const data: unknown = JSON.parse(dataLine.slice("data: ".length));
      if (event === "citations") handlers.onCitations?.(data as ChatCitation[]);
      else if (event === "token") handlers.onToken?.((data as { text: string }).text);
      else if (event === "error")
        handlers.onError?.((data as { message: string }).message);
      else if (event === "done") {
        handlers.onDone?.();
        return;
      }
    }
  }
  handlers.onDone?.();
}
