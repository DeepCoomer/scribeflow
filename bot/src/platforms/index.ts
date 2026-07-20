import { meetPlatform } from "./meet.js";
import { zoomPlatform } from "./zoom.js";
import type { PlatformStrategy } from "./types.js";

export type {
  AdmissionSignal,
  LandingClassification,
  PlatformStrategy,
} from "./types.js";

export function getPlatform(name: "meet" | "zoom"): PlatformStrategy {
  return name === "meet" ? meetPlatform : zoomPlatform;
}
