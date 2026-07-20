// RabbitMQ topology (ticket 1.2) — the single source of truth on the Node
// side; workers/scribeflow_workers/topology.py mirrors it exactly. Both sides
// declare the same objects idempotently on connect, so whichever service
// boots first creates them and the other's asserts are no-ops.
//
// Layout per docs/architecture.md §Queue topology, with the retry ladder
// implemented as explicit tiered retry queues (D43):
//
//   pipeline (topic)  ── meeting.uploaded ──▶ q.transcriber   (Phase 1, D45;
//                                             Phase 2 rebinds to q.slicer)
//   events (fanout)   ──▶ per-API-instance exclusive queue (SSE forwarding)
//
//   q.<worker>.retry.{30s,2m,10m}: no consumers; x-message-ttl + dead-letter
//   back to the work queue via the default exchange. The worker framework
//   republishes a failed message to the tier matching its attempt count and
//   acks the original; after MAX_ATTEMPTS it goes to q.parking for a human.

export const PIPELINE_EXCHANGE = "pipeline";
export const EVENTS_EXCHANGE = "events";

export const ROUTING_KEYS = {
  meetingUploaded: "meeting.uploaded",
  chunkTranscribe: "chunk.transcribe",
  meetingDiarize: "meeting.diarize",
  meetingStitch: "meeting.stitch",
  meetingExtract: "meeting.extract",
  meetingEmbed: "meeting.embed",
  // Ticket 5.3 (D69): the slicer worker also owns concatenating a bot's
  // rolling segments into the meeting's canonical recording.
  meetingFinalize: "meeting.finalize",
  // Ticket 5.5: consumed by the bot orchestrator, published by the API's
  // "invite bot now" endpoint.
  botSpawn: "bot.spawn",
} as const;

export const RETRY_TIERS = [
  { suffix: "30s", ttlMs: 30_000 },
  { suffix: "2m", ttlMs: 120_000 },
  { suffix: "10m", ttlMs: 600_000 },
] as const;

// A message is attempted MAX_ATTEMPTS times total (1 initial + one per
// retry tier), then parked.
export const MAX_ATTEMPTS = 1 + RETRY_TIERS.length;

export const PARKING_QUEUE = "q.parking";

// Ticket 5.5 (D31/D70/D72): the bot orchestrator's own spawn queue,
// deliberately outside WORK_QUEUES below — a stale spawn request should
// just expire (queue-level TTL), never retry-ladder into q.parking.
export const BOT_SPAWN_QUEUE_NAME = "q.bot_spawn";
export const BOT_SPAWN_TTL_MS = 30 * 60 * 1000;

export type QueueSpec = {
  name: string;
  /** pipeline-exchange routing keys bound to this queue */
  bindings: readonly string[];
};

// Phase 2 (D45 realized): the slicer owns meeting.uploaded; the transcriber
// moves to chunk.transcribe, and the diarizer/stitcher queues are new.
// Prefetch is a consumer-side (Python) concern, not a queue-declare argument,
// so it isn't mirrored here — see workers/scribeflow_workers/topology.py.
export const SLICER_QUEUE: QueueSpec = {
  name: "q.slicer",
  // Ticket 5.3 (D69): meeting.finalize also lands here — the slicer already
  // owns ffmpeg/R2/the publish primitive (D51).
  bindings: [ROUTING_KEYS.meetingUploaded, ROUTING_KEYS.meetingFinalize],
};

export const TRANSCRIBER_QUEUE: QueueSpec = {
  name: "q.transcriber",
  bindings: [ROUTING_KEYS.chunkTranscribe],
};

export const DIARIZER_QUEUE: QueueSpec = {
  name: "q.diarizer",
  bindings: [ROUTING_KEYS.meetingDiarize],
};

export const STITCHER_QUEUE: QueueSpec = {
  name: "q.stitcher",
  bindings: [ROUTING_KEYS.meetingStitch],
};

// Phase 3 (3.1/3.2, D59): the intelligence pass — action items, decisions,
// summary, and batched per-utterance sentiment — all run as one job per
// meeting, published by the stitcher once the transcript is final.
export const EXTRACTOR_QUEUE: QueueSpec = {
  name: "q.extractor",
  bindings: [ROUTING_KEYS.meetingExtract],
};

// Ticket 3.5 (D63): embeds every transcript segment, one job per meeting,
// published by the stitcher alongside meeting.extract — runs in parallel
// with extraction, not folded into the same job, so a slow/failed embed
// never blocks or retries the intelligence pass.
export const EMBEDDER_QUEUE: QueueSpec = {
  name: "q.embedder",
  bindings: [ROUTING_KEYS.meetingEmbed],
};

export const WORK_QUEUES: readonly QueueSpec[] = [
  SLICER_QUEUE,
  TRANSCRIBER_QUEUE,
  DIARIZER_QUEUE,
  STITCHER_QUEUE,
  EXTRACTOR_QUEUE,
  EMBEDDER_QUEUE,
];

export function retryQueueName(queue: string, tierSuffix: string): string {
  return `${queue}.retry.${tierSuffix}`;
}
