import { useState } from "react";

// Ticket 2.6: click a speaker's name in the transcript to rename it inline.
// NULL-speaker segments never render this (the caller shows "Unknown"
// instead, D55) — there's no label to rename against.
export function SpeakerName({
  displayName,
  onRename,
}: {
  displayName: string;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayName);

  function commit() {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== displayName) onRename(trimmed);
    else setDraft(displayName);
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(displayName);
            setEditing(false);
          }
        }}
        style={{ fontWeight: "bold", fontSize: "inherit", width: 120 }}
      />
    );
  }

  return (
    <strong
      onClick={() => {
        setDraft(displayName);
        setEditing(true);
      }}
      title="Click to rename"
      style={{ cursor: "pointer" }}
    >
      {displayName}
    </strong>
  );
}
