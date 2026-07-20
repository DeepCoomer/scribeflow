// The lifecycle taxonomy from docs/meet-bot.md's join-flow state machine:
//   spawning -> joining -> lobby -> recording -> leaving -> done
//                      \-> not_admitted | denied | blocked | invalid_url | failed
// Mirrored exactly by api/src/db/schema.ts's botSessionStateEnum — keep both
// in sync in the same commit (same rule as the queue topology mirror).
export const BOT_STATES = [
  "spawning",
  "joining",
  "lobby",
  "recording",
  "leaving",
  "done",
  "not_admitted",
  "denied",
  "blocked",
  "invalid_url",
  "failed",
] as const;

export type BotState = (typeof BOT_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<BotState> = new Set([
  "done",
  "not_admitted",
  "denied",
  "blocked",
  "invalid_url",
  "failed",
]);

export function isTerminal(state: BotState): boolean {
  return TERMINAL_STATES.has(state);
}
