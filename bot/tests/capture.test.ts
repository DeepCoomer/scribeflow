import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  buildFfmpegArgs,
  parseSegmentIndex,
  segmentFilename,
  Capture,
  sampleRms,
  runAudioHealthCheck,
  type SegmentEvent,
} from "../src/capture.js";
import type { ControlPlaneClient } from "../src/controlPlaneClient.js";

class FakeChildProcess extends EventEmitter {
  stdin = {
    write: (_data: string) => {
      // Simulates ffmpeg closing the last segment and exiting cleanly on 'q'.
      setTimeout(() => this.emit("exit", 0), 5);
    },
  };
  stdout = new EventEmitter();
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    setTimeout(() => this.emit("exit", 0), 1);
    return true;
  }
}

describe("buildFfmpegArgs", () => {
  it("captures the PulseAudio monitor at 16kHz mono Opus in rolling segments (D67)", () => {
    const args = buildFfmpegArgs("/rec", 300);
    expect(args).toEqual(
      expect.arrayContaining([
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
        "300",
        "-reset_timestamps",
        "1",
      ]),
    );
    expect(args.at(-1)).toBe("/rec/seg_%03d.ogg");
  });
});

describe("parseSegmentIndex / segmentFilename", () => {
  it("round-trips an index through the filename format", () => {
    expect(parseSegmentIndex(segmentFilename(7))).toBe(7);
    expect(segmentFilename(7)).toBe("seg_007.ogg");
  });

  it("returns null for anything that doesn't match", () => {
    expect(parseSegmentIndex("audio.flac")).toBeNull();
    expect(parseSegmentIndex("seg_abc.ogg")).toBeNull();
  });
});

describe("Capture", () => {
  it("reports a segment closed only once the next index appears on disk", async () => {
    const events: SegmentEvent[] = [];
    let call = 0;
    const listDir = async (): Promise<string[]> => {
      call += 1;
      if (call <= 2) return ["seg_000.ogg"];
      return ["seg_000.ogg", "seg_001.ogg"];
    };
    const fakeProc = new FakeChildProcess();

    const capture = new Capture(
      "/rec",
      300,
      (e) => {
        events.push(e);
      },
      {
        spawn: () => fakeProc as unknown as ChildProcess,
        listDir,
        now: () => 1_000,
        pollMs: 10,
      },
    );
    capture.start();
    await new Promise((r) => setTimeout(r, 50));

    // seg_001 hasn't appeared until call 3, and the highest-indexed file is
    // never reported until it's superseded — only seg_000 should be closed.
    expect(events.map((e) => e.idx)).toEqual([0]);

    await capture.stop();
    // stop() flushes whatever's left on disk, including the still-open
    // final segment — seg_001 is now reported too.
    expect(events.map((e) => e.idx)).toEqual([0, 1]);
    expect(events[0]?.startedAtMs).toBe(1_000);
  });

  it("stops ffmpeg via stdin q rather than an immediate kill", async () => {
    const fakeProc = new FakeChildProcess();
    const capture = new Capture("/rec", 300, () => undefined, {
      spawn: () => fakeProc as unknown as ChildProcess,
      listDir: async () => [],
      now: () => 0,
      pollMs: 10,
    });
    capture.start();
    await capture.stop();
    expect(fakeProc.killed).toBe(false);
  });
});

describe("sampleRms", () => {
  function spawnEmitting(
    samples: number[],
  ): (cmd: string, args: string[]) => ChildProcess {
    return () => {
      const proc = new FakeChildProcess();
      setTimeout(() => {
        const buf = Buffer.alloc(samples.length * 2);
        samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
        proc.stdout.emit("data", buf);
      }, 1);
      return proc as unknown as ChildProcess;
    };
  }

  it("is ~0 for silence", async () => {
    const rms = await sampleRms({ spawn: spawnEmitting([0, 0, 0, 0]), durationMs: 15 });
    expect(rms).toBeLessThan(0.001);
  });

  it("is well above the silence threshold for a loud signal", async () => {
    const rms = await sampleRms({
      spawn: spawnEmitting([16384, -16384, 16384, -16384]),
      durationMs: 15,
    });
    expect(rms).toBeGreaterThan(0.4);
  });
});

describe("runAudioHealthCheck", () => {
  const fakeCp: ControlPlaneClient = {
    heartbeat: vi.fn(async () => undefined),
    event: vi.fn(async () => undefined),
    segmentUrl: vi.fn(async () => ({ url: "", key: "" })),
    debugUrl: vi.fn(async () => ({ url: "", key: "" })),
  };

  it("reports healthy without restarting when audio is present", async () => {
    const restartAudioChain = vi.fn(async () => undefined);
    const spawn = (): ChildProcess => {
      const proc = new FakeChildProcess();
      setTimeout(() => proc.stdout.emit("data", Buffer.from([0, 64, 0, 64])), 1);
      return proc as unknown as ChildProcess;
    };
    const result = await runAudioHealthCheck(
      { spawn, durationMs: 10, restartAudioChain },
      fakeCp,
    );
    expect(result).toEqual({ healthy: true, restarted: false });
    expect(restartAudioChain).not.toHaveBeenCalled();
  });

  it("restarts once and reports unhealthy when silence persists", async () => {
    const restartAudioChain = vi.fn(async () => undefined);
    const spawn = (): ChildProcess => new FakeChildProcess() as unknown as ChildProcess; // no data => silence
    const result = await runAudioHealthCheck(
      { spawn, durationMs: 10, restartAudioChain },
      fakeCp,
    );
    expect(result).toEqual({ healthy: false, restarted: true });
    expect(restartAudioChain).toHaveBeenCalledTimes(1);
  });
});
