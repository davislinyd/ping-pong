import type { ThroughputStats } from "./contracts.js";

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

export function steadyMbpsFromSamples(samples: ThroughputSample[], fallbackBytes: number, fallbackElapsedMs: number): number {
  return throughputStatsFromSamples(samples, fallbackBytes, fallbackElapsedMs).meanMbps;
}

export function throughputStatsFromSamples(samples: ThroughputSample[], fallbackBytes: number, fallbackElapsedMs: number): ThroughputStats {
  const mbpsSamples = samples
    .map((sample) => bytesToMbps(sample.bytes, sample.elapsedMs))
    .filter((value) => Number.isFinite(value));

  if (mbpsSamples.length > 0) {
    const stableSamples = mbpsSamples.slice(startupDiscardCount(mbpsSamples.length));
    return statsFromMbpsSamples(stableSamples);
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

export function filterIqrOutliers(values: number[]): number[] {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 4) return finite;
  const { q1, q3, iqr } = quartiles(finite);
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;
  return finite.filter((value) => value >= lower && value <= upper);
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

function statsFromMbpsSamples(samples: number[]): ThroughputStats {
  const filtered = filterIqrOutliers(samples);
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
