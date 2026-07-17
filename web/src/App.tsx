import { useEffect, useState } from "react";
import { getToken, setToken } from "./api.js";
import { AuthPage } from "./pages/AuthPage.js";
import { MeetingsPage } from "./pages/MeetingsPage.js";
import { MeetingDetailPage } from "./pages/MeetingDetailPage.js";

// Hash routing keeps the SPA a single static file with zero dependencies —
// react-router earns its keep when the dashboard grows past two routes
// (Phase 3's action-items UI is the likely tipping point).
function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const route = useHashRoute();
  const [authed, setAuthed] = useState(getToken() !== null);

  if (!authed || route === "#/login") {
    return (
      <AuthPage
        onAuthed={() => {
          // A prior 401 (api.ts) can strand the hash on #/login; without
          // clearing it here, a successful login re-renders straight back
          // into this same gate since the hash never changes on its own.
          if (window.location.hash === "#/login") window.location.hash = "#/";
          setAuthed(true);
        }}
      />
    );
  }

  const meetingMatch = route.match(/^#\/meetings\/([0-9a-f-]{36})$/);

  return (
    <main
      style={{
        fontFamily: "system-ui",
        maxWidth: 760,
        margin: "0 auto",
        padding: "1.5rem",
      }}
    >
      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          borderBottom: "1px solid #e5e7eb",
          paddingBottom: 8,
          marginBottom: 16,
        }}
      >
        <a href="#/" style={{ textDecoration: "none", color: "inherit" }}>
          <strong>ScribeFlow</strong>
        </a>
        <button
          style={{ background: "none", border: "none", color: "#6b7280" }}
          onClick={() => {
            setToken(null);
            setAuthed(false);
          }}
        >
          Log out
        </button>
      </header>
      {meetingMatch ? <MeetingDetailPage id={meetingMatch[1]!} /> : <MeetingsPage />}
    </main>
  );
}
