import { useEffect, useState } from "react";
import { api, getCurrentUserId, type ActionItem } from "../api.js";

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Ticket 3.8: the nudger's daily email digest is optional (Resend may not be
// configured), but this "is it actually overdue" flag isn't — it's a plain
// computation from data the page already has, so it always works.
function isOverdue(item: ActionItem): boolean {
  return (
    item.status === "open" && item.dueDate !== null && new Date(item.dueDate) < new Date()
  );
}

// Ticket 3.3: the tenant-wide action-items dashboard — every meeting's
// extracted commitments in one list, with assign/complete controls and a
// link back to the transcript moment they came from.
export function ActionItemsPage() {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const currentUserId = getCurrentUserId();

  async function refresh() {
    try {
      const { actionItems } = await api.listActionItems();
      setItems(actionItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function setStatus(item: ActionItem, status: ActionItem["status"]) {
    const updated = await api.updateActionItem(item.meetingId, item.id, { status });
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...updated } : i)));
  }

  // No tenant user-directory endpoint exists yet (Phase 6+), so "assign" is
  // scoped to "assign to me" / "unassign" rather than a full picker.
  async function toggleAssignToMe(item: ActionItem) {
    const ownerUserId = item.ownerUserId === currentUserId ? null : currentUserId;
    const updated = await api.updateActionItem(item.meetingId, item.id, { ownerUserId });
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, ...updated } : i)));
  }

  const open = items.filter((i) => i.status === "open");
  const closed = items.filter((i) => i.status !== "open");

  return (
    <div>
      <h2>Action items</h2>
      {error && <p style={{ color: "crimson" }}>{error}</p>}
      {items.length === 0 && !error && (
        <p style={{ color: "#666" }}>
          No action items yet — they appear here once a meeting's transcript has been
          processed.
        </p>
      )}
      <div style={{ display: "grid", gap: 8 }}>
        {open.map((item) => (
          <ActionItemRow
            key={item.id}
            item={item}
            currentUserId={currentUserId}
            onToggleDone={() => void setStatus(item, "done")}
            onDismiss={() => void setStatus(item, "dismissed")}
            onToggleAssign={() => void toggleAssignToMe(item)}
          />
        ))}
      </div>
      {closed.length > 0 && (
        <>
          <h3 style={{ color: "#666", marginTop: 24 }}>Done / dismissed</h3>
          <div style={{ display: "grid", gap: 8, opacity: 0.6 }}>
            {closed.map((item) => (
              <ActionItemRow
                key={item.id}
                item={item}
                currentUserId={currentUserId}
                onToggleDone={() => void setStatus(item, "open")}
                onDismiss={() => void setStatus(item, "dismissed")}
                onToggleAssign={() => void toggleAssignToMe(item)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ActionItemRow({
  item,
  currentUserId,
  onToggleDone,
  onDismiss,
  onToggleAssign,
}: {
  item: ActionItem;
  currentUserId: string | null;
  onToggleDone: () => void;
  onDismiss: () => void;
  onToggleAssign: () => void;
}) {
  const due = fmtDate(item.dueDate);
  const transcriptLink = item.sourceSegmentId
    ? `#/meetings/${item.meetingId}?segment=${item.sourceSegmentId}`
    : `#/meetings/${item.meetingId}`;

  return (
    <div
      style={{
        border: "1px solid #e5e7eb",
        borderRadius: 8,
        padding: "10px 14px",
        display: "flex",
        alignItems: "flex-start",
        gap: 10,
      }}
    >
      <input
        type="checkbox"
        checked={item.status === "done"}
        onChange={onToggleDone}
        style={{ marginTop: 4 }}
      />
      <div style={{ flex: 1 }}>
        <div
          style={{
            textDecoration: item.status === "done" ? "line-through" : "none",
          }}
        >
          {item.text}
        </div>
        <div style={{ fontSize: 13, color: "#6b7280", display: "flex", gap: 10 }}>
          <a href={transcriptLink} style={{ color: "inherit" }}>
            {item.meetingTitle ?? "View transcript"}
          </a>
          {item.ownerName && <span>owner: {item.ownerName}</span>}
          {due && (
            <span
              style={isOverdue(item) ? { color: "#dc2626", fontWeight: 600 } : undefined}
            >
              {isOverdue(item) ? `overdue since ${due}` : `due ${due}`}
            </span>
          )}
        </div>
      </div>
      <button onClick={onToggleAssign} disabled={!currentUserId}>
        {item.ownerUserId === currentUserId ? "Assigned to me" : "Assign to me"}
      </button>
      {item.status !== "dismissed" && <button onClick={onDismiss}>Dismiss</button>}
    </div>
  );
}
