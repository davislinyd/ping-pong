import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LOCAL_THROTTLE, type ResultPayload, type RuntimeConfigResponse, type ThroughputStats } from "../src/shared/contracts";
import { isSpeedTestWorkerAbort, startSpeedTestWorker, type SpeedTestWorkerLike } from "../src/client/speed-test-worker-client";
import type { SpeedTestWorkerMessage, SpeedTestWorkerRequest } from "../src/client/speed-test-worker-protocol";
import type { RawTestData, TestProgress } from "../src/client/speed-test-core";

describe("speed test worker client", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts start config, forwards progress, and resolves completed results", async () => {
    const worker = new FakeWorker();
    const progress: TestProgress[] = [];
    const config = baseConfig();
    const result = baseResult();
    const rawData = baseRawData();

    const run = startSpeedTestWorker(config, "unknown", (next) => progress.push(next), () => worker);

    expect(worker.messages).toEqual([{ type: "start", config, networkLinkType: "unknown" }]);

    worker.emitMessage({ type: "progress", progress: { phase: "download", label: "Download", progressPercent: 25 } });
    worker.emitMessage({ type: "complete", result, rawData });

    await expect(run.promise).resolves.toEqual({ result, rawData });
    expect(progress).toEqual([{ phase: "download", label: "Download", progressPercent: 25 }]);

    run.terminate();
    expect(worker.terminated).toBe(true);
  });

  it("rejects worker errors", async () => {
    const worker = new FakeWorker();
    const run = startSpeedTestWorker(baseConfig(), "unknown", () => undefined, () => worker);

    worker.emitMessage({ type: "error", message: "Worker failed" });

    await expect(run.promise).rejects.toThrow("Worker failed");
  });

  it("terminates cleanly and ignores late worker messages", async () => {
    const worker = new FakeWorker();
    const progress: TestProgress[] = [];
    const run = startSpeedTestWorker(baseConfig(), "unknown", (next) => progress.push(next), () => worker);

    run.terminate();
    worker.emitMessage({ type: "progress", progress: { phase: "upload", label: "Upload", progressPercent: 50 } });
    worker.emitMessage({ type: "complete", result: baseResult({ downloadMbps: 1 }), rawData: baseRawData() });

    await run.promise.then(
      () => {
        throw new Error("Expected worker termination to reject");
      },
      (error: unknown) => {
        expect(isSpeedTestWorkerAbort(error)).toBe(true);
      }
    );
    expect(worker.terminated).toBe(true);
    expect(progress).toEqual([]);
  });

  it("rejects uncaught worker runtime errors", async () => {
    const worker = new FakeWorker();
    const run = startSpeedTestWorker(baseConfig(), "unknown", () => undefined, () => worker);

    worker.emitError("Uncaught worker error");

    await expect(run.promise).rejects.toThrow("Uncaught worker error");
  });

  it("does not time out a 30 second test before its watchdog fires", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const run = startSpeedTestWorker(baseConfig({ defaultTestDurationSeconds: 30 }), "unknown", () => undefined, () => worker);
    let rejected = false;
    run.promise.catch(() => {
      rejected = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(rejected).toBe(false);
    run.terminate();
    await expect(run.promise).rejects.toThrow("Speed test worker terminated.");
  });

  it("rejects a 30 second test at the full watchdog limit", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const run = startSpeedTestWorker(baseConfig({ defaultTestDurationSeconds: 30 }), "unknown", () => undefined, () => worker);
    const timeoutExpectation = expect(run.promise).rejects.toThrow("Speed test timed out");

    await vi.advanceTimersByTimeAsync(80_000);

    await timeoutExpectation;
  });

  it("clears the watchdog when the worker completes before timeout", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const result = baseResult({ durationSeconds: 30 });
    const rawData = baseRawData();
    const run = startSpeedTestWorker(baseConfig({ defaultTestDurationSeconds: 30 }), "unknown", () => undefined, () => worker);

    await vi.advanceTimersByTimeAsync(79_000);
    worker.emitMessage({ type: "complete", result, rawData });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(run.promise).resolves.toEqual({ result, rawData });
  });
});

class FakeWorker implements SpeedTestWorkerLike {
  readonly messages: SpeedTestWorkerRequest[] = [];
  terminated = false;

  private readonly messageListeners = new Set<(event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) => void>();
  private readonly errorListeners = new Set<(event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) => void>();

  addEventListener(type: "message" | "error", listener: (event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) => void): void {
    if (type === "message") {
      this.messageListeners.add(listener);
    } else {
      this.errorListeners.add(listener);
    }
  }

  removeEventListener(type: "message" | "error", listener: (event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) => void): void {
    if (type === "message") {
      this.messageListeners.delete(listener);
    } else {
      this.errorListeners.delete(listener);
    }
  }

  postMessage(message: SpeedTestWorkerRequest): void {
    this.messages.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emitMessage(message: SpeedTestWorkerMessage): void {
    const event = { data: message } as MessageEvent<SpeedTestWorkerMessage>;
    for (const listener of this.messageListeners) {
      listener(event);
    }
  }

  emitError(message: string): void {
    const event = { message } as ErrorEvent;
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }
}

function baseConfig(patch: Partial<RuntimeConfigResponse> = {}): RuntimeConfigResponse {
  return {
    serverName: "Ping Pong",
    defaultTestDurationSeconds: 8,
    parallelConnections: 4,
    maxTestBytes: 67_108_864,
    catSpeedRanges: {
      idle: { minMbps: 0, maxMbps: 0 },
      walk: { minMbps: 0, maxMbps: 50 },
      jog: { minMbps: 50, maxMbps: 200 },
      run: { minMbps: 200, maxMbps: 800 },
      sprint: { minMbps: 800, maxMbps: null }
    },
    clientSafety: {
      isLocalClient: true,
      canRunTest: true,
      reason: "loopback",
      message: null
    },
    localThrottle: DEFAULT_LOCAL_THROTTLE,
    ...patch
  };
}

function baseResult(patch: Partial<ResultPayload> = {}): ResultPayload {
  return {
    downloadMbps: 900,
    uploadMbps: 880,
    downloadStats: stats(850, 900, 950, 12),
    uploadStats: stats(820, 880, 930, 12),
    idleLatencyMs: 4,
    downloadLoadedLatencyMs: 22,
    uploadLoadedLatencyMs: 24,
    jitterMs: 1.5,
    httpLossPercent: 0,
    durationSeconds: 8,
    parallelConnections: 4,
    networkLinkType: "unknown",
    testProfile: "standard",
    ...patch
  };
}

function baseRawData(): RawTestData {
  return {
    downloadThroughput: [{ bytes: 1_000_000, elapsedMs: 1000 }],
    uploadThroughput: [{ bytes: 900_000, elapsedMs: 1000 }],
    idleLatency: [4],
    downloadLoadedLatency: [22],
    uploadLoadedLatency: [24]
  };
}

function stats(p10Mbps: number, p50Mbps: number, p90Mbps: number, sampleCount: number): ThroughputStats {
  return {
    meanMbps: p50Mbps,
    p10Mbps,
    p50Mbps,
    p75Mbps: (p50Mbps + p90Mbps) / 2,
    p90Mbps,
    rawCvPercent: 5,
    cvPercent: 5,
    sampleCount,
    filteredSampleCount: sampleCount
  };
}
