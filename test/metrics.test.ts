import { describe, expect, it } from "vitest";

import { DEFAULT_CAT_SPEED_RANGES, catSpeedStageForMbps, normalizeCatSpeedRanges } from "../src/shared/contracts";
import {
  bytesToMegabits,
  bytesToMbps,
  classifyLatencySamples,
  classifyThroughputSamples,
  coefficientOfVariation,
  filterIqrOutliers,
  jitter,
  lossPercent,
  median,
  percentile,
  quartiles,
  safePercent,
  startupDiscardCount,
  standardDeviation,
  steadyMbpsFromSamples,
  throughputStatsFromSamples
} from "../src/shared/metrics";

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

  it("trims the first 3 percent of startup throughput samples", () => {
    expect(startupDiscardCount(1)).toBe(0);
    expect(startupDiscardCount(50)).toBe(2);
    expect(startupDiscardCount(76)).toBe(3);
    expect(startupDiscardCount(116)).toBe(4);
  });

  it("summarizes throughput samples with mean, percentiles, CV, and sample count", () => {
    const samples = [10, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 220].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    }));

    expect(throughputStatsFromSamples(samples, 0, 1000)).toEqual({
      meanMbps: 120,
      p10Mbps: 40,
      p50Mbps: 120,
      p75Mbps: 170,
      p90Mbps: 200,
      rawCvPercent: 52.71,
      cvPercent: 52.71,
      sampleCount: 11,
      filteredSampleCount: 11
    });
  });

  it("uses IQR to drop outliers when computing mean and CV", () => {
    const samples = [10, 11, 12, 13, 14, 15, 16, 17, 18, 1000].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    }));

    const stats = throughputStatsFromSamples(samples, 0, 1000);
    expect(stats.meanMbps).toBeCloseTo(14.5, 1);
    expect(stats.rawCvPercent).toBeGreaterThan(200);
    expect(stats.cvPercent).toBeLessThan(20);
    expect(stats.filteredSampleCount).toBe(8);
    expect(stats.sampleCount).toBe(9);
    expect(stats.p90Mbps).toBeGreaterThan(100);
  });

  it("removes a proportional startup segment instead of only the first sample", () => {
    const samples = [1000, 20, ...Array.from({ length: 48 }, () => 100)].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    }));

    expect(throughputStatsFromSamples(samples, 0, 1000)).toMatchObject({
      meanMbps: 100,
      sampleCount: 48,
      filteredSampleCount: 48
    });
  });

  it("keeps raw percentiles while computing the primary mean from post-startup IQR-filtered samples", () => {
    const samples = [5, 100, 0, 100, 100, 100, 100, 100, 100, 1000].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    }));

    expect(throughputStatsFromSamples(samples, 0, 1000)).toEqual({
      meanMbps: 100,
      p10Mbps: 80,
      p50Mbps: 100,
      p75Mbps: 100,
      p90Mbps: 280,
      rawCvPercent: 152.71,
      cvPercent: 0,
      sampleCount: 9,
      filteredSampleCount: 7
    });
  });

  it("classifies startup and IQR-excluded throughput samples", () => {
    const samples = [5, 100, 0, 100, 100, 100, 100, 100, 100, 1000].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    }));

    const classified = classifyThroughputSamples(samples);

    expect(classified[0]).toMatchObject({
      sampleIndex: 1,
      mbps: 5,
      status: "startup-excluded",
      excludedFrom: ["Stable Mean", "Stable CV", "Raw CV", "P10/P50/P75/P90"]
    });
    expect(classified.filter((sample) => sample.status === "iqr-excluded").map((sample) => sample.mbps)).toEqual([0, 1000]);
    expect(classified.filter((sample) => sample.status === "used")).toHaveLength(7);
  });

  it("classifies failed and IQR-excluded latency samples", () => {
    const classified = classifyLatencySamples([10, 11, 12, 13, 14, 15, 16, 17, 18, 1000, null], "Loaded Latency Median");

    expect(classified[9]).toMatchObject({
      sampleIndex: 10,
      ms: 1000,
      status: "iqr-excluded",
      usedIn: ["HTTP Loss"],
      excludedFrom: ["Loaded Latency Median"]
    });
    expect(classified[10]).toMatchObject({
      sampleIndex: 11,
      ms: null,
      status: "failed",
      usedIn: ["HTTP Loss"],
      excludedFrom: ["Loaded Latency Median"]
    });
  });

  it("uses available post-warmup samples and falls back only when none exist", () => {
    expect(steadyMbpsFromSamples([{ bytes: 1_000_000, elapsedMs: 1000 }], 12_500_000, 1000)).toBe(8);
    expect(steadyMbpsFromSamples([], 0, 1000)).toBe(0);
    expect(throughputStatsFromSamples([{ bytes: 1_000_000, elapsedMs: 1000 }], 12_500_000, 1000)).toMatchObject({
      meanMbps: 8,
      p10Mbps: 8,
      p50Mbps: 8,
      p75Mbps: 8,
      p90Mbps: 8,
      rawCvPercent: 0,
      cvPercent: 0,
      sampleCount: 1,
      filteredSampleCount: 1
    });
  });

  it("computes quartiles, IQR filter, stddev, and CV", () => {
    expect(quartiles([1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual({ q1: 3, q3: 7, iqr: 4 });
    expect(filterIqrOutliers([10, 11, 12, 13, 14, 15, 16, 17, 18, 1000])).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
    expect(filterIqrOutliers([1, 2, 3])).toEqual([1, 2, 3]);
    expect(standardDeviation([2, 2, 2, 2])).toBe(0);
    expect(standardDeviation([1, 5])).toBe(2);
    expect(coefficientOfVariation([100, 100, 100])).toBe(0);
    expect(coefficientOfVariation([])).toBe(0);
    expect(coefficientOfVariation([10, 12, 14, 16])).toBeCloseTo(17.21, 1);
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
