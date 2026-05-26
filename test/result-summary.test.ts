import { describe, expect, it } from "vitest";

import { DEFAULT_CAT_SPEED_RANGES, type ResultPayload, type ThroughputStats } from "../src/shared/contracts";
import { buildCompletionSummary } from "../src/client/result-summary";

describe("completion result summary", () => {
  it("reports an excellent connection for high speed, low latency, and no loss", () => {
    const summary = buildCompletionSummary(baseResult(), DEFAULT_CAT_SPEED_RANGES);

    expect(summary.title).toBe("Excellent connection");
    expect(summary.primaryLimit).toBe("reliability");
    expect(summary.subtitle).toBe("Stable throughput - No packet loss");
    expect(tile(summary, "Reliability")?.value).toBe("Clean");
  });

  it("treats reliability as the bottleneck when high loss is present", () => {
    const summary = buildCompletionSummary(baseResult({ httpLossPercent: 3 }), DEFAULT_CAT_SPEED_RANGES);

    expect(summary.title).toBe("Needs attention");
    expect(summary.primaryLimit).toBe("reliability");
    expect(summary.subtitle).toContain("Reliability is the main limit");
    expect(tile(summary, "Reliability")?.value).toBe("Loss observed");
  });

  it("treats wide P10 to P90 spread as a stability bottleneck", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadStats: stats(100, 600, 1300, 12, 120),
        uploadStats: stats(820, 900, 960, 12)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.title).toBe("Needs attention");
    expect(summary.primaryLimit).toBe("stability");
    expect(summary.subtitle).toContain("Stability is the main limit");
    expect(tile(summary, "Stability")?.value).toBe("Unstable");
  });

  it("uses raw CV to catch unstable Wi-Fi-style throughput even when stable mean is high", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadStats: stats(820, 900, 960, 50, 5, 36),
        uploadStats: stats(820, 880, 930, 50, 5, 8)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.title).toBe("Needs attention");
    expect(summary.primaryLimit).toBe("stability");
    expect(tile(summary, "Stability")?.detail).toContain("36% raw CV");
  });

  it("uses low P10 to mean ratio as a stability bottleneck", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadStats: stats(300, 900, 960, 50, 5, 5),
        uploadStats: stats(820, 880, 930, 50, 5, 5)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.primaryLimit).toBe("stability");
    expect(tile(summary, "Stability")?.detail).toContain("P10/mean 33.3%");
  });

  it("uses IQR outlier rate as a stability bottleneck", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadStats: stats(820, 900, 960, 50, 5, 5, 42),
        uploadStats: stats(820, 880, 930, 50, 5, 5, 50)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.primaryLimit).toBe("stability");
    expect(tile(summary, "Stability")?.detail).toContain("16% outliers");
  });

  it("uses jitter as a stability bottleneck", () => {
    const summary = buildCompletionSummary(baseResult({ jitterMs: 38 }), DEFAULT_CAT_SPEED_RANGES);

    expect(summary.title).toBe("Needs attention");
    expect(summary.primaryLimit).toBe("stability");
    expect(summary.subtitle).toContain("Stability is the main limit");
    expect(tile(summary, "Stability")?.detail).toContain("38 ms jitter");
  });

  it("adds Wi-Fi isolation guidance when stability is poor", () => {
    const summary = buildCompletionSummary(baseResult({ jitterMs: 38, networkLinkType: "wifi" }), DEFAULT_CAT_SPEED_RANGES);

    expect(summary.subtitle).toContain("Retry on Wired to isolate the wireless segment");
    expect(summary.networkLinkTypeLabel).toBe("Wi-Fi");
  });

  it("adds wired path guidance when reliability is poor", () => {
    const summary = buildCompletionSummary(baseResult({ httpLossPercent: 3, networkLinkType: "wired" }), DEFAULT_CAT_SPEED_RANGES);

    expect(summary.primaryLimit).toBe("reliability");
    expect(summary.subtitle).toContain("Check switch, uplink, or server path");
    expect(summary.networkLinkTypeLabel).toBe("Wired");
  });

  it("keeps speed as a tile but not the main limit unless speed is poor", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadMbps: 900,
        uploadMbps: 120,
        downloadStats: stats(820, 900, 960, 12),
        uploadStats: stats(110, 120, 130, 12)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.limitingSide).toBe("upload");
    expect(summary.primaryLimit).toBe("reliability");
    expect(tile(summary, "Speed Tier")?.value).toBe("Jog");
    expect(tile(summary, "Speed Tier")?.detail).toBe("Upload-limited trimmed-mean floor 120 Mbps");
  });

  it("treats unusable speed as the main limit", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadMbps: 900,
        uploadMbps: 20,
        uploadStats: stats(18, 20, 22, 12)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.title).toBe("Needs attention");
    expect(summary.primaryLimit).toBe("speed");
    expect(summary.limitingSide).toBe("upload");
  });

  it("handles legacy or insufficient samples without NaN or a stability penalty", () => {
    const summary = buildCompletionSummary(
      baseResult({
        downloadStats: stats(850, 900, 950, 0),
        uploadStats: stats(820, 880, 930, 0)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.title).toBe("Excellent connection");
    expect(tile(summary, "Stability")?.value).toBe("Not enough samples");
    expect(JSON.stringify(summary)).not.toContain("NaN");
  });
});

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
    durationSeconds: 15,
    parallelConnections: 4,
    networkLinkType: "unknown",
    ...patch
  };
}

function stats(p10Mbps: number, p50Mbps: number, p90Mbps: number, sampleCount: number, cvPercent = 5, rawCvPercent = cvPercent, filteredSampleCount = sampleCount): ThroughputStats {
  return {
    meanMbps: p50Mbps,
    p10Mbps,
    p50Mbps,
    p75Mbps: (p50Mbps + p90Mbps) / 2,
    p90Mbps,
    rawCvPercent,
    cvPercent,
    sampleCount,
    filteredSampleCount
  };
}

function tile(summary: ReturnType<typeof buildCompletionSummary>, label: string) {
  return summary.tiles.find((item) => item.label === label);
}
