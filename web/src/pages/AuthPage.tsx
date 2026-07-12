import { useState, type FormEvent } from "react";
import { api, setToken } from "../api.js";

export function AuthPage({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email"));
    const password = String(form.get("password"));
    setBusy(true);
    setError(null);
    try {
      const { token } =
        mode === "login"
          ? await api.login({ email, password })
          : await api.register({
              tenantName: String(form.get("tenantName")),
              name: String(form.get("name")),
              email,
              password,
            });
      setToken(token);
      onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 360, margin: "10vh auto" }}>
      <h1>ScribeFlow</h1>
      <p style={{ color: "#666" }}>
        {mode === "login" ? "Log in to your team" : "Create a team"}
      </p>
      <form onSubmit={submit} style={{ display: "grid", gap: 8 }}>
        {mode === "register" && (
          <>
            <input name="tenantName" placeholder="Team name" required minLength={2} />
            <input name="name" placeholder="Your name" required />
          </>
        )}
        <input name="email" type="email" placeholder="Email" required />
        <input
          name="password"
          type="password"
          placeholder="Password"
          required
          minLength={8}
        />
        <button type="submit" disabled={busy}>
          {mode === "login" ? "Log in" : "Sign up"}
        </button>
      </form>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      <button
        style={{ marginTop: 12, background: "none", border: "none", color: "#2563eb" }}
        onClick={() => setMode(mode === "login" ? "register" : "login")}
      >
        {mode === "login" ? "New here? Create a team" : "Have an account? Log in"}
      </button>
    </div>
  );
}
