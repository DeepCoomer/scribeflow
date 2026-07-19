import { describe, it, expect } from "vitest";
import { composeDefaultFollowup } from "./followup.js";

describe("composeDefaultFollowup (3.7, D65)", () => {
  it("groups action items by owner, unassigned last", () => {
    const body = composeDefaultFollowup({
      meetingTitle: "Weekly sync",
      summary: "Discussed the roadmap.",
      decisions: [{ text: "Ship Friday" }],
      actionItems: [
        { text: "Write the doc", ownerName: "Alice" },
        { text: "File the ticket", ownerName: null },
        { text: "Review the PR", ownerName: "Bob" },
      ],
    });

    expect(body).toContain('Quick recap from "Weekly sync"');
    expect(body).toContain("Discussed the roadmap.");
    expect(body).toContain("Decisions:\n- Ship Friday");

    const aliceIdx = body.indexOf("Alice:");
    const bobIdx = body.indexOf("Bob:");
    const unassignedIdx = body.indexOf("Unassigned:");
    expect(aliceIdx).toBeGreaterThan(-1);
    expect(bobIdx).toBeGreaterThan(aliceIdx); // alphabetical
    expect(unassignedIdx).toBeGreaterThan(bobIdx); // unassigned always last
    expect(body).toContain("  - Write the doc");
  });

  it("omits the decisions/action-items sections when empty", () => {
    const body = composeDefaultFollowup({
      meetingTitle: "Empty meeting",
      summary: "Nothing happened.",
      decisions: [],
      actionItems: [],
    });
    expect(body).not.toContain("Decisions:");
    expect(body).not.toContain("Action items:");
  });
});
