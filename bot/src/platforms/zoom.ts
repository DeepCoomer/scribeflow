import type { PlatformStrategy } from "./types.js";

// Phase 8 (docs/plan.md): Zoom's web client permits guest joins, so this
// strategy ports the container/browser design directly — only the
// selectors and join/leave copy differ. Not implemented yet; the interface
// exists from day one (ticket 5.2) so Phase 8 is a second file, not a
// rewrite of joinFlow.ts/lifecycle.ts.
export const zoomPlatform: PlatformStrategy = {
  name: "zoom",
  normalizeUrl() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
  async classifyLanding() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
  async requestToJoin() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
  async pollAdmission() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
  async dismissPostAdmissionModals() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
  async announceRecording() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
  async leave() {
    throw new Error("zoom platform is not implemented yet (Phase 8)");
  },
};
