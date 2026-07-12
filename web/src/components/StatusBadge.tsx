import type { Meeting } from "../api.js";

const COLORS: Record<Meeting["status"], string> = {
  pending: "#9ca3af",
  uploading: "#f59e0b",
  processing: "#f59e0b",
  transcribing: "#3b82f6",
  partial: "#f97316",
  done: "#16a34a",
  failed: "#dc2626",
};

export function StatusBadge({ status }: { status: Meeting["status"] }) {
  return (
    <span
      style={{
        color: COLORS[status],
        border: `1px solid ${COLORS[status]}`,
        borderRadius: 999,
        padding: "1px 10px",
        fontSize: 13,
      }}
    >
      {status}
    </span>
  );
}
