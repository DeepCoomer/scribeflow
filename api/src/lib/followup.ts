// Ticket 3.7 (D65): the follow-up email's default draft — grouped by owner,
// unlike 3.4's flat summary email, since a follow-up's whole point is "here's
// what's on your plate" per person. Composed from data 3.1 already extracted
// (no extra LLM call: the human edits this before sending anyway, so a
// template is enough — see D65 for the full reasoning and why this isn't
// folded into the extractor's Groq call).

export type FollowupActionItem = {
  text: string;
  ownerName: string | null;
};

export type FollowupDecision = {
  text: string;
};

export function composeDefaultFollowup(opts: {
  meetingTitle: string;
  summary: string;
  decisions: FollowupDecision[];
  actionItems: FollowupActionItem[];
}): string {
  const { meetingTitle, summary, decisions, actionItems } = opts;
  const lines: string[] = [
    `Hi team,`,
    "",
    `Quick recap from "${meetingTitle}":`,
    "",
    summary,
  ];

  if (decisions.length > 0) {
    lines.push("", "Decisions:");
    for (const d of decisions) lines.push(`- ${d.text}`);
  }

  if (actionItems.length > 0) {
    lines.push("", "Action items:");
    const byOwner = new Map<string, FollowupActionItem[]>();
    for (const item of actionItems) {
      const owner = item.ownerName ?? "Unassigned";
      const list = byOwner.get(owner) ?? [];
      list.push(item);
      byOwner.set(owner, list);
    }
    const owners = [...byOwner.keys()].sort((a, b) =>
      a === "Unassigned" ? 1 : b === "Unassigned" ? -1 : a.localeCompare(b),
    );
    for (const owner of owners) {
      lines.push(`${owner}:`);
      for (const item of byOwner.get(owner)!) lines.push(`  - ${item.text}`);
    }
  }

  lines.push("", "— Sent via ScribeFlow");
  return lines.join("\n");
}
