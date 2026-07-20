import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ControlPlaneClient } from "./controlPlaneClient.js";
import { getLogger } from "./logging.js";

const log = getLogger("capture");

export const SEGMENT_FILENAME_RE = /^seg_(\d+)\.ogg$/;

export function parseSegmentIndex(filename: string): number | null {
  const m = SEGMENT_FILENAME_RE.exec(filename);
  return m ? Number(m[1]) : null;
}

export function segmentFilename(idx: number): string {
  return `seg_${String(idx).padStart(3, "0")}.ogg`;
}

// PulseAudio null-sink monitor -> ffmpeg, 16 kHz mono Opus, rolling
// non-overlapping segments (ticket 5.3, D67 — segments are crash insurance,
// not pipeline chunks; D69 owns what happens to them downstream).
export function buildFfmpegArgs(outDir: string, segmentS: number): string[] {
  return [
    "-f",
    "pulse",
    "-i",
    "meet_out.monitor",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "libopus",
    "-b:a",
    "24k",
    "-f",
    "segment",
    "-segment_time",
    String(segmentS),
    "-reset_timestamps",
    "1",
    path.join(outDir, "seg_%03d.ogg"),
  ];
}

export type SpawnFn = (cmd: string, args: string[]) => ChildProcess;

export type SegmentEvent = { idx: number; path: string; startedAtMs: number };
export type SegmentHandler = (event: SegmentEvent) => void | Promise<void>;

export type CaptureDeps = {
  spawn: SpawnFn;
  listDir: (dir: string) => Promise<string[]>;
  now: () => number;
  pollMs: number;
};

export const defaultCaptureDeps: CaptureDeps = {
  spawn: (cmd, args) => nodeSpawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] }),
  listDir: (dir) => readdir(dir),
  now: Date.now,
  pollMs: 1000,
};

// Rolling ffmpeg segment capture. A segment is safe to upload once ffmpeg
// has moved on to the next index — the segment muxer closes seg_NNN before
// opening seg_(NNN+1), so a new file's appearance on disk is a reliable
// "prior segment fully flushed" signal without parsing ffmpeg's own logs.
export class Capture {
  private proc: ChildProcess | null = null;
  private readonly segmentStartedAtMs = new Map<number, number>();
  private notifiedUpTo = -1;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly deps: CaptureDeps;

  constructor(
    private readonly outDir: string,
    private readonly segmentS: number,
    private readonly onSegment: SegmentHandler,
    deps: Partial<CaptureDeps> = {},
  ) {
    this.deps = { ...defaultCaptureDeps, ...deps };
  }

  start(): void {
    this.segmentStartedAtMs.set(0, this.deps.now());
    this.proc = this.deps.spawn("ffmpeg", buildFfmpegArgs(this.outDir, this.segmentS));
    this.proc.on("exit", (code) => log.info("ffmpeg.exited", { code }));
    this.pollTimer = setInterval(() => {
      void this.checkForClosedSegments();
    }, this.deps.pollMs);
  }

  private async checkForClosedSegments(): Promise<void> {
    const files = await this.deps.listDir(this.outDir).catch(() => [] as string[]);
    const indices = files
      .map(parseSegmentIndex)
      .filter((i): i is number => i !== null)
      .sort((a, b) => a - b);
    if (indices.length === 0) return;
    const highest = indices[indices.length - 1]!;
    // The highest-indexed file present is still being written; every index
    // below it has already been superseded, i.e. closed.
    for (const idx of indices) {
      if (idx >= highest) break;
      if (idx <= this.notifiedUpTo) continue;
      this.segmentStartedAtMs.set(idx + 1, this.deps.now());
      await this.emit(idx);
    }
  }

  private async emit(idx: number): Promise<void> {
    this.notifiedUpTo = idx;
    const startedAtMs = this.segmentStartedAtMs.get(idx) ?? this.deps.now();
    await this.onSegment({
      idx,
      path: path.join(this.outDir, segmentFilename(idx)),
      startedAtMs,
    });
  }

  // Graceful ladder (docs/meet-bot.md): stdin 'q' asks ffmpeg to close the
  // current segment and exit cleanly; SIGTERM at +15s and SIGKILL at +5s
  // more cover a wedged process. The still-open final segment is on disk
  // either way once the process is gone, so it's flushed after exit.
  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const proc = this.proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(termTimer);
        clearTimeout(killTimer);
        resolve();
      };
      proc.once("exit", finish);
      proc.stdin?.write("q");
      const termTimer = setTimeout(() => proc.kill("SIGTERM"), 15_000);
      const killTimer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    });
    await this.flushFinalSegment();
  }

  private async flushFinalSegment(): Promise<void> {
    const files = await this.deps.listDir(this.outDir).catch(() => [] as string[]);
    const indices = files.map(parseSegmentIndex).filter((i): i is number => i !== null);
    const highest = indices.length ? Math.max(...indices) : -1;
    for (let idx = this.notifiedUpTo + 1; idx <= highest; idx++) {
      await this.emit(idx);
    }
  }
}

// -- audio health probe (ticket 5.3) -----------------------------------------

const SILENCE_RMS_THRESHOLD = 0.001;

export type RmsDeps = { spawn: SpawnFn; durationMs?: number };

// Samples raw PCM off the PulseAudio monitor via parec and computes RMS
// (normalized 0..1). Flat silence — a PulseAudio misconfig, most likely —
// shows up as a near-zero value regardless of what's happening in the call.
export async function sampleRms(deps: RmsDeps): Promise<number> {
  const durationMs = deps.durationMs ?? 1000;
  const proc = deps.spawn("parec", [
    "--format=s16le",
    "--rate=16000",
    "--channels=1",
    "-d",
    "meet_out.monitor",
  ]);
  const chunks: Buffer[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  proc.kill("SIGTERM");
  await new Promise((resolve) => proc.once("exit", resolve));

  const buf = Buffer.concat(chunks);
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = buf.readInt16LE(i * 2) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

export type AudioHealthDeps = RmsDeps & { restartAudioChain: () => Promise<void> };

// 60s after admission (caller schedules this), sample RMS once; on silence,
// restart the audio chain exactly once, then report unhealthy but keep
// recording — a silent recording still proves the lifecycle worked; the
// alert explains why it's empty (docs/meet-bot.md).
export async function runAudioHealthCheck(
  deps: AudioHealthDeps,
  cp: ControlPlaneClient,
): Promise<{ healthy: boolean; restarted: boolean }> {
  const first = await sampleRms(deps);
  if (first >= SILENCE_RMS_THRESHOLD) {
    return { healthy: true, restarted: false };
  }
  log.warn("audio.silence_detected", { rms: first });
  await deps.restartAudioChain();
  const second = await sampleRms(deps);
  const healthy = second >= SILENCE_RMS_THRESHOLD;
  await cp.heartbeat("recording", { rmsHealthy: healthy }).catch(() => undefined);
  if (!healthy) {
    log.error("audio.still_silent_after_restart", { rms: second });
  }
  return { healthy, restarted: true };
}
