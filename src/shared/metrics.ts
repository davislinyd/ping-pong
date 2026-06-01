import type { NetworkLinkType, ThroughputStats } from "./contracts.js";

export function roundTo(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function bytesToMbps(bytes: number, elapsedMs: number): number {
  if (bytes <= 0 || elapsedMs <= 0) return 0;
  return roundTo((bytes * 8) / (elapsedMs / 1000) / 1_000_000, 2);
}

export function bytesToMegabits(bytes: number): number {
  if (bytes <= 0) return 0;
  return roundTo((bytes * 8) / 1_000_000, 2);
}

export type ThroughputSample = {
  bytes: number;
  elapsedMs: number;
};

export type ThroughputSampleStatus = "used" | "startup-excluded" | "iqr-excluded";

export type ClassifiedThroughputSample = {
  sampleIndex: number;
  bytes: number;
  elapsedMs: number;
  mbps: number;
  status: ThroughputSampleStatus;
  reason: string;
  usedIn: string[];
  excludedFrom: string[];
};

export type LatencySampleStatus = "used" | "iqr-excluded" | "failed";

export type ClassifiedLatencySample = {
  sampleIndex: number;
  ms: number | null;
  status: LatencySampleStatus;
  reason: string;
  usedIn: string[];
  excludedFrom: string[];
};

export function steadyMbpsFromSamples(samples: ThroughputSample[], fallbackBytes: number, fallbackElapsedMs: number): number {
  return throughputStatsFromSamples(samples, fallbackBytes, fallbackElapsedMs).meanMbps;
}

export function throughputStatsFromSamples(
  samples: ThroughputSample[],
  fallbackBytes: number,
  fallbackElapsedMs: number,
  networkLinkType?: NetworkLinkType
): ThroughputStats {
  const mbpsSamples = samples
    .map((sample) => bytesToMbps(sample.bytes, sample.elapsedMs))
    .filter((value) => Number.isFinite(value));

  if (mbpsSamples.length > 0) {
    const stableSamples = mbpsSamples.slice(startupDiscardCount(mbpsSamples.length));
    return statsFromMbpsSamples(stableSamples, networkLinkType);
  }

  const fallbackMbps = bytesToMbps(fallbackBytes, fallbackElapsedMs);
  return {
    meanMbps: fallbackMbps,
    p10Mbps: fallbackMbps,
    p50Mbps: fallbackMbps,
    p75Mbps: fallbackMbps,
    p90Mbps: fallbackMbps,
    rawCvPercent: 0,
    cvPercent: 0,
    sampleCount: mbpsSamples.length,
    filteredSampleCount: mbpsSamples.length
  };
}

export function startupDiscardCount(sampleCount: number): number {
  if (sampleCount <= 1) return 0;
  return Math.min(sampleCount - 1, Math.max(1, Math.ceil(sampleCount * 0.03)));
}

export function classifyThroughputSamples(samples: ThroughputSample[], networkLinkType?: NetworkLinkType): ClassifiedThroughputSample[] {
  const records = samples.map((sample, index) => ({
    sampleIndex: index + 1,
    bytes: sample.bytes,
    elapsedMs: sample.elapsedMs,
    mbps: bytesToMbps(sample.bytes, sample.elapsedMs)
  }));
  const discardCount = startupDiscardCount(records.length);
  const steadyRecords = records.slice(discardCount);
  const multiplier = networkLinkType === "wired" ? 1.2 : 1.5;
  const bounds = iqrBounds(steadyRecords.map((sample) => sample.mbps), multiplier);

  return records.map((sample, index) => {
    if (index < discardCount) {
      return {
        ...sample,
        status: "startup-excluded",
        reason: "Startup trim",
        usedIn: ["Raw data"],
        excludedFrom: ["Stable Mean", "Stable CV", "Raw CV", "P10/P50/P75/P90"]
      };
    }

    if (bounds && (sample.mbps < bounds.lower || sample.mbps > bounds.upper)) {
      return {
        ...sample,
        status: "iqr-excluded",
        reason: "IQR outlier",
        usedIn: ["Raw CV", "P10/P50/P75/P90"],
        excludedFrom: ["Stable Mean", "Stable CV"]
      };
    }

    return {
      ...sample,
      status: "used",
      reason: "Included",
      usedIn: ["Stable Mean", "Stable CV", "Raw CV", "P10/P50/P75/P90"],
      excludedFrom: []
    };
  });
}

export function classifyLatencySamples(samples: Array<number | null>, medianLabel: string): ClassifiedLatencySample[] {
  const finite = samples.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const bounds = iqrBounds(finite);

  return samples.map((sample, index) => {
    if (typeof sample !== "number" || !Number.isFinite(sample)) {
      return {
        sampleIndex: index + 1,
        ms: null,
        status: "failed",
        reason: "Request failed",
        usedIn: ["HTTP Loss"],
        excludedFrom: [medianLabel]
      };
    }

    if (bounds && (sample < bounds.lower || sample > bounds.upper)) {
      return {
        sampleIndex: index + 1,
        ms: sample,
        status: "iqr-excluded",
        reason: "IQR outlier",
        usedIn: ["HTTP Loss"],
        excludedFrom: [medianLabel]
      };
    }

    return {
      sampleIndex: index + 1,
      ms: sample,
      status: "used",
      reason: "Included",
      usedIn: [medianLabel, "HTTP Loss"],
      excludedFrom: []
    };
  });
}

export function percentile(values: number[], targetPercentile: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;

  const boundedPercentile = Math.max(0, Math.min(100, targetPercentile));
  const rank = ((sorted.length - 1) * boundedPercentile) / 100;
  const lowerIndex = Math.floor(rank);
  const upperIndex = Math.ceil(rank);
  const lower = sorted[lowerIndex] ?? 0;
  const upper = sorted[upperIndex] ?? lower;

  return roundTo(lower + (upper - lower) * (rank - lowerIndex));
}

export function quartiles(values: number[]): { q1: number; q3: number; iqr: number } {
  const q1 = percentile(values, 25);
  const q3 = percentile(values, 75);
  return { q1, q3, iqr: q3 - q1 };
}

function iqrBounds(values: number[], multiplier = 1.5): { lower: number; upper: number } | null {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 4) return null;
  const { q1, q3, iqr } = quartiles(finite);
  return {
    lower: q1 - multiplier * iqr,
    upper: q3 + multiplier * iqr
  };
}

export function filterIqrOutliers(values: number[], multiplier = 1.5): number[] {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 4) return finite;
  const bounds = iqrBounds(finite, multiplier);
  if (!bounds) return finite;
  return finite.filter((value) => value >= bounds.lower && value <= bounds.upper);
}

export function standardDeviation(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return 0;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length;
  return roundTo(Math.sqrt(variance));
}

export function coefficientOfVariation(values: number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return 0;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (mean <= 0) return 0;
  return roundTo((standardDeviation(finite) / mean) * 100);
}

function statsFromMbpsSamples(samples: number[], networkLinkType?: NetworkLinkType): ThroughputStats {
  const multiplier = networkLinkType === "wired" ? 1.2 : 1.5;
  const filtered = filterIqrOutliers(samples, multiplier);
  const meanSource = filtered.length > 0 ? filtered : samples;
  const mean = meanSource.reduce((sum, value) => sum + value, 0) / Math.max(1, meanSource.length);
  return {
    meanMbps: roundTo(mean),
    p10Mbps: percentile(samples, 10),
    p50Mbps: percentile(samples, 50),
    p75Mbps: percentile(samples, 75),
    p90Mbps: percentile(samples, 90),
    rawCvPercent: coefficientOfVariation(samples),
    cvPercent: coefficientOfVariation(meanSource),
    sampleCount: samples.length,
    filteredSampleCount: filtered.length
  };
}

export function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return roundTo(sorted[middle] ?? 0, 2);
  return roundTo(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2, 2);
}

export function jitter(values: number[]): number {
  const sorted = values.filter(Number.isFinite);
  if (sorted.length < 2) return 0;

  const deltas = sorted.slice(1).map((value, index) => Math.abs(value - (sorted[index] ?? value)));
  return roundTo(deltas.reduce((sum, value) => sum + value, 0) / deltas.length, 2);
}

export function lossPercent(sent: number, failed: number): number {
  if (sent <= 0 || failed <= 0) return 0;
  return roundTo((failed / sent) * 100, 2);
}

export function safePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, roundTo(value, 2)));
}
