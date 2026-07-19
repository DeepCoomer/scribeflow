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
  bindings: [ROUTING_KEYS.meetingUploaded],
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

export const WORK_QUEUES: readonly QueueSpec[] = [
  SLICER_QUEUE,
  TRANSCRIBER_QUEUE,
  DIARIZER_QUEUE,
  STITCHER_QUEUE,
];

export function retryQueueName(queue: string, tierSuffix: string): string {
  return `${queue}.retry.${tierSuffix}`;
}
