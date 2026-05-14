import { describe, expect, it } from "vitest";

import { DEFAULT_CAT_SPEED_RANGES, catSpeedStageForMbps, normalizeCatSpeedRanges } from "../src/shared/contracts";
import { bytesToMegabits, bytesToMbps, jitter, lossPercent, median, percentile, safePercent, steadyMbpsFromSamples, throughputStatsFromSamples } from "../src/shared/metrics";

describe("metric helpers", () => {
  it("calculates Mbps from effective bytes and elapsed milliseconds", () => {
    expect(bytesToMbps(12_500_000, 1000)).toBe(100);
    expect(bytesToMbps(3_750_000, 1500)).toBe(20);
    expect(bytesToMbps(0, 1000)).toBe(0);
    expect(bytesToMbps(1000, 0)).toBe(0);
  });

  it("calculates accumulated megabits from bytes", () => {
    expect(bytesToMegabits(1_000_000)).toBe(8);
    expect(bytesToMegabits(1_234_567)).toBe(9.88);
    expect(bytesToMegabits(0)).toBe(0);
  });

  it("calculates percentile values with interpolation", () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110];

    expect(percentile(samples, 10)).toBe(20);
    expect(percentile(samples, 50)).toBe(60);
    expect(percentile(samples, 90)).toBe(100);
  });

  it("calculates steady Mbps without the first startup sample", () => {
    expect(
      steadyMbpsFromSamples(
        [
          { bytes: 1_000_000, elapsedMs: 1000 },
          { bytes: 12_500_000, elapsedMs: 1000 },
          { bytes: 15_000_000, elapsedMs: 1000 }
        ],
        28_500_000,
        3000
      )
    ).toBe(110);
  });

  it("summarizes throughput samples with P10, P50, P90, and sample count", () => {
    const samples = [10, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    }));

    expect(throughputStatsFromSamples(samples, 0, 1000)).toEqual({
      p10Mbps: 40,
      p50Mbps: 120,
      p90Mbps: 200,
      sampleCount: 11
    });
  });

  it("falls back to total throughput when steady samples are insufficient", () => {
    expect(steadyMbpsFromSamples([{ bytes: 1_000_000, elapsedMs: 1000 }], 12_500_000, 1000)).toBe(100);
    expect(steadyMbpsFromSamples([], 0, 1000)).toBe(0);
    expect(throughputStatsFromSamples([{ bytes: 1_000_000, elapsedMs: 1000 }], 12_500_000, 1000)).toMatchObject({
      p10Mbps: 100,
      p50Mbps: 100,
      p90Mbps: 100,
      sampleCount: 1
    });
  });

  it("keeps zero-byte steady windows after measurement has started", () => {
    expect(
      steadyMbpsFromSamples(
        [
          { bytes: 1_000_000, elapsedMs: 1000 },
          { bytes: 0, elapsedMs: 1000 },
          { bytes: 12_500_000, elapsedMs: 1000 }
        ],
        13_500_000,
        3000
      )
    ).toBe(50);
  });

  it("calculates median latency", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 30, 20])).toBe(25);
    expect(median([])).toBe(0);
  });

  it("calculates jitter from adjacent latency deltas", () => {
    expect(jitter([10, 12, 18, 17])).toBe(3);
    expect(jitter([10])).toBe(0);
  });

  it("calculates HTTP loss percentage", () => {
    expect(lossPercent(10, 2)).toBe(20);
    expect(lossPercent(0, 2)).toBe(0);
  });

  it("bounds percentages", () => {
    expect(safePercent(120)).toBe(100);
    expect(safePercent(-5)).toBe(0);
  });

  it("normalizes missing cat speed ranges and maps Mbps to stages", () => {
    const fallback = normalizeCatSpeedRanges(undefined);

    expect(fallback).toEqual(DEFAULT_CAT_SPEED_RANGES);
    expect(catSpeedStageForMbps(0, fallback)).toBe("idle");
    expect(catSpeedStageForMbps(25, fallback)).toBe("walk");
    expect(catSpeedStageForMbps(120, fallback)).toBe("jog");
    expect(catSpeedStageForMbps(300, fallback)).toBe("run");
    expect(catSpeedStageForMbps(900, fallback)).toBe("sprint");
  });

  it("falls back to default cat ranges when a partial payload is not continuous", () => {
    expect(
      normalizeCatSpeedRanges({
        idle: { minMbps: 0, maxMbps: 0 },
        walk: { minMbps: 10, maxMbps: 50 }
      })
    ).toEqual(DEFAULT_CAT_SPEED_RANGES);
  });
});
