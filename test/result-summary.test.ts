import { describe, expect, it } from "vitest";

import { DEFAULT_CAT_SPEED_RANGES, type ResultPayload, type ThroughputStats } from "../src/shared/contracts";
import { buildCompletionSummary } from "../src/client/result-summary";

describe("completion result summary", () => {
  it("reports an excellent connection for high speed, low latency, and no loss", () => {
    const summary = buildCompletionSummary(baseResult(), DEFAULT_CAT_SPEED_RANGES);

    expect(summary.title).toBe("Excellent connection");
    expect(summary.primaryLimit).toBe("speed");
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
        downloadStats: stats(100, 600, 1300, 12),
        uploadStats: stats(820, 900, 960, 12)
      }),
      DEFAULT_CAT_SPEED_RANGES
    );

    expect(summary.title).toBe("Needs attention");
    expect(summary.primaryLimit).toBe("stability");
    expect(summary.subtitle).toContain("Stability is the main limit");
    expect(tile(summary, "Stability")?.value).toBe("Unstable");
  });

  it("calls out upload when upload is the limiting side", () => {
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
    expect(summary.subtitle).toContain("Upload is the limiting side");
    expect(tile(summary, "Speed Tier")?.value).toBe("Jog");
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
    ...patch
  };
}

function stats(p10Mbps: number, p50Mbps: number, p90Mbps: number, sampleCount: number): ThroughputStats {
  return { p10Mbps, p50Mbps, p90Mbps, sampleCount };
}

function tile(summary: ReturnType<typeof buildCompletionSummary>, label: string) {
  return summary.tiles.find((item) => item.label === label);
}
