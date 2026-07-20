// Shared between the spawn-queue consumer and the control-plane
// server/reaper: a spawn message is acked only once its session reaches a
// terminal state (that's the static semaphore, D72 — see queue.ts's
// prefetch comment). Whoever observes the terminal transition first
// resolves it; this registry is just the handoff point between them.

export type SessionRegistry = {
  registerPendingAck(sessionId: string, ack: () => void): void;
  resolveTerminal(sessionId: string): void;
  hasPending(sessionId: string): boolean;
};

export function createSessionRegistry(): SessionRegistry {
  const pending = new Map<string, () => void>();
  return {
    registerPendingAck(sessionId, ack) {
      pending.set(sessionId, ack);
    },
    resolveTerminal(sessionId) {
      const ack = pending.get(sessionId);
      if (!ack) return;
      pending.delete(sessionId);
      ack();
    },
    hasPending(sessionId) {
      return pending.has(sessionId);
    },
  };
}
