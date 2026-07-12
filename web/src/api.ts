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
};

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
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
    request<{ meeting: Meeting; segments: Segment[] }>(`/meetings/${id}/transcript`),
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
