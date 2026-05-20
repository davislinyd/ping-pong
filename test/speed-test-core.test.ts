import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CAT_SPEED_RANGES, type RuntimeConfigResponse } from "../src/shared/contracts";
import { createEmptyMetricSeries, runSpeedTest, type TestPhase } from "../src/client/speed-test-core";

const testConfig: RuntimeConfigResponse = {
  serverName: "Test",
  defaultTestDurationSeconds: 3,
  parallelConnections: 1,
  maxTestBytes: 67_108_864,
  catSpeedRanges: DEFAULT_CAT_SPEED_RANGES,
  clientSafety: { isLocalClient: false, canRunTest: true, reason: null, message: null }
};

describe("createEmptyMetricSeries", () => {
  it("returns all empty arrays with the correct keys", () => {
    expect(createEmptyMetricSeries()).toEqual({
      downloadMbps: [],
      uploadMbps: [],
      idleLatencyMs: [],
      loadedLatencyMs: [],
      jitterMs: [],
      httpLossPercent: []
    });
  });

  it("returns independent instances on each call", () => {
    const a = createEmptyMetricSeries();
    const b = createEmptyMetricSeries();
    a.downloadMbps.push(100);
    expect(b.downloadMbps).toHaveLength(0);
  });
});

describe("runSpeedTest", () => {
  let fakeNow = 0;
  let performanceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fakeNow = 0;
    performanceSpy = vi.spyOn(performance, "now").mockImplementation(() => fakeNow);
  });

  afterEach(() => {
    performanceSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  function stubFetch({ advancePerDownload = 700, advancePerUpload = 700, failLatency = false } = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/api/latency")) {
          if (failLatency) return new Response(null, { status: 503 });
          return new Response(JSON.stringify({ ok: true, serverTime: Date.now() }), { status: 200 });
        }
        if (url.includes("/api/download")) {
          fakeNow += advancePerDownload;
          return new Response(new Uint8Array(65_536), { status: 200 });
        }
        if (url.includes("/api/upload")) {
          fakeNow += advancePerUpload;
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      })
    );
  }

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runSpeedTest(testConfig, () => {}, controller.signal)).rejects.toThrow();
  });

  it("rejects when aborted during a test run", async () => {
    stubFetch();
    const controller = new AbortController();
    const promise = runSpeedTest(testConfig, () => {}, controller.signal);
    await new Promise((r) => setTimeout(r, 50));
    controller.abort();
    await expect(promise).rejects.toThrow();
  }, 5_000);

  it("calls progress with phases in order: latency → download → upload", async () => {
    stubFetch();
    const phases: TestPhase[] = [];

    await runSpeedTest(
      testConfig,
      (p) => {
        if (phases[phases.length - 1] !== p.phase) phases.push(p.phase);
      },
      new AbortController().signal
    );

    expect(phases[0]).toBe("latency");
    expect(phases.indexOf("download")).toBeGreaterThan(phases.indexOf("latency"));
    expect(phases.indexOf("upload")).toBeGreaterThan(phases.indexOf("download"));
  }, 10_000);

  it("returns a ResultPayload with the correct shape and value ranges", async () => {
    stubFetch();
    const result = await runSpeedTest(testConfig, () => {}, new AbortController().signal);

    expect(result.durationSeconds).toBe(testConfig.defaultTestDurationSeconds);
    expect(result.parallelConnections).toBe(testConfig.parallelConnections);
    expect(result.downloadMbps).toBeGreaterThanOrEqual(0);
    expect(result.uploadMbps).toBeGreaterThanOrEqual(0);
    expect(result.idleLatencyMs).toBeGreaterThanOrEqual(0);
    expect(result.jitterMs).toBeGreaterThanOrEqual(0);
    expect(result.httpLossPercent).toBeGreaterThanOrEqual(0);
    expect(result.httpLossPercent).toBeLessThanOrEqual(100);
    expect(result.downloadStats.sampleCount).toBeGreaterThanOrEqual(0);
    expect(result.uploadStats.sampleCount).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it("reports non-zero HTTP loss when latency calls fail", async () => {
    stubFetch({ failLatency: true });
    const result = await runSpeedTest(testConfig, () => {}, new AbortController().signal);
    expect(result.httpLossPercent).toBeGreaterThan(0);
  }, 10_000);

  it("tracks download and upload megabits in progress callbacks", async () => {
    stubFetch();
    let sawDownloadMegabits = false;
    let sawUploadMegabits = false;

    await runSpeedTest(
      testConfig,
      (p) => {
        if (typeof p.downloadMegabits === "number" && p.downloadMegabits > 0) sawDownloadMegabits = true;
        if (typeof p.uploadMegabits === "number" && p.uploadMegabits > 0) sawUploadMegabits = true;
      },
      new AbortController().signal
    );

    expect(sawDownloadMegabits).toBe(true);
    expect(sawUploadMegabits).toBe(true);
  }, 10_000);
});
