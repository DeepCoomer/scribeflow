import type { BotSessionRow, Db } from "../../src/orchestrator/db.js";
import type { ContainerStatus, DockerClient } from "../../src/orchestrator/docker.js";
import type { OrchestratorQueue } from "../../src/orchestrator/queue.js";
import type { BotSessionState } from "../../src/orchestrator/messages.js";
import { isTerminal } from "../../src/orchestrator/messages.js";

let nextId = 1;

export function makeFakeDb(): Db & { rows: Map<string, BotSessionRow> } {
  const rows = new Map<string, BotSessionRow>();

  const db: Db & { rows: Map<string, BotSessionRow> } = {
    rows,
    async findNonTerminalSessionForMeeting(meetingId) {
      for (const row of rows.values()) {
        if (row.meetingId === meetingId && !isTerminal(row.state)) return row;
      }
      return null;
    },
    async createSession(fields) {
      const row: BotSessionRow = {
        id: `session-${nextId++}`,
        tenantId: fields.tenantId,
        meetingId: fields.meetingId,
        jobKey: fields.jobKey,
        meetUrl: fields.meetUrl,
        containerId: null,
        state: "spawning",
        sessionToken: fields.sessionToken,
        segmentsUploaded: 0,
        rejoined: false,
      };
      rows.set(row.id, row);
      return row;
    },
    async findSessionById(id) {
      return rows.get(id) ?? null;
    },
    async setContainerId(id, containerId) {
      const row = rows.get(id);
      if (row) row.containerId = containerId;
    },
    async recordHeartbeat(id, state) {
      const row = rows.get(id);
      if (row) row.state = state;
    },
    async recordEvent(id, state) {
      const row = rows.get(id);
      if (row) row.state = state;
    },
    async incrementSegmentsUploaded(id) {
      const row = rows.get(id);
      if (row) row.segmentsUploaded += 1;
    },
    async markRejoined(id, containerId) {
      const row = rows.get(id);
      if (row) {
        row.rejoined = true;
        row.containerId = containerId;
        row.state = "joining";
      }
    },
    async listStaleNonTerminal() {
      return [...rows.values()].filter((r) => !isTerminal(r.state));
    },
  };
  return db;
}

export function makeFakeDocker(): DockerClient & {
  containers: Map<string, { running: boolean; exitCode: number | null }>;
  runCalls: { name: string; image: string; env: Record<string, string> }[];
} {
  const containers = new Map<string, { running: boolean; exitCode: number | null }>();
  const runCalls: { name: string; image: string; env: Record<string, string> }[] = [];
  let nextContainerId = 1;

  return {
    containers,
    runCalls,
    async runDetached(opts) {
      const id = `container-${nextContainerId++}`;
      containers.set(id, { running: true, exitCode: null });
      runCalls.push({ name: opts.name, image: opts.image, env: opts.env });
      return { id };
    },
    async inspect(id): Promise<ContainerStatus | null> {
      return containers.get(id) ?? null;
    },
    async removeForce(id) {
      containers.delete(id);
    },
  };
}

export function makeFakeQueue(): OrchestratorQueue & {
  acked: unknown[];
  finalized: { tenantId: string; meetingId: string }[];
  botStatuses: { sessionId: string; state: BotSessionState }[];
} {
  const acked: unknown[] = [];
  const finalized: { tenantId: string; meetingId: string }[] = [];
  const botStatuses: { sessionId: string; state: BotSessionState }[] = [];

  return {
    acked,
    finalized,
    botStatuses,
    // Only `.ack` is ever used by the code under test.
    channel: {
      ack: (msg: unknown) => acked.push(msg),
    } as unknown as OrchestratorQueue["channel"],
    async publishFinalize(tenantId, meetingId) {
      finalized.push({ tenantId, meetingId });
    },
    async publishBotStatus(fields) {
      botStatuses.push({ sessionId: fields.sessionId, state: fields.state });
    },
    async consumeSpawn() {
      /* driven directly by tests instead */
    },
    async close() {
      /* no-op */
    },
  };
}

export function fakeConsumeMessage(body: unknown): { content: Buffer } {
  return { content: Buffer.from(JSON.stringify(body)) };
}
