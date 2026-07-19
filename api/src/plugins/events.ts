import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { pipelineEventV1, type PipelineEventV1 } from "../queue/messages.js";

export type EventSubscriber = (event: PipelineEventV1) => void;

export type Events = {
  /** Returns an unsubscribe function. */
  subscribe: (tenantId: string, fn: EventSubscriber) => () => void;
  /** Local dispatch — used by the queue consumer and directly by tests. */
  dispatch: (event: PipelineEventV1) => void;
};

// Per-tenant SSE subscriber registry (ticket 1.6). Workers publish state
// transitions to the `events` fanout exchange; the queue plugin's consumer
// hands them here and each connected dashboard gets only its own tenant's
// events — scoping by the tenantId in the verified JWT, never by anything
// client-supplied.
export default fp(async function eventsPlugin(app: FastifyInstance) {
  const subscribers = new Map<string, Set<EventSubscriber>>();

  const events: Events = {
    subscribe(tenantId, fn) {
      let set = subscribers.get(tenantId);
      if (!set) {
        set = new Set();
        subscribers.set(tenantId, set);
      }
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0) subscribers.delete(tenantId);
      };
    },
    dispatch(event) {
      const set = subscribers.get(event.tenant_id);
      if (!set) return;
      for (const fn of set) fn(event);
    },
  };

  app.decorate("events", events);

  app.queue.onEvent((raw) => {
    const parsed = pipelineEventV1.safeParse(raw);
    if (!parsed.success) {
      app.log.warn({ raw }, "ignoring unrecognized event message");
      return;
    }
    events.dispatch(parsed.data);
  });
});
