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
  return throughputStatsFromSamples(samples, fallbackBytes, fallbackElapsedMs).p50Mbps;
}

export function throughputStatsFromSamples(samples: ThroughputSample[], fallbackBytes: number, fallbackElapsedMs: number): ThroughputStats {
  const mbpsSamples = samples
    .map((sample) => bytesToMbps(sample.bytes, sample.elapsedMs))
    .filter((value) => Number.isFinite(value));

  if (mbpsSamples.length > 1) {
    const stableSamples = mbpsSamples.slice(1);
    return statsFromMbpsSamples(stableSamples);
  }

  const fallbackMbps = bytesToMbps(fallbackBytes, fallbackElapsedMs);
  return {
    p10Mbps: fallbackMbps,
    p50Mbps: fallbackMbps,
    p90Mbps: fallbackMbps,
    sampleCount: mbpsSamples.length
  };
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

function statsFromMbpsSamples(samples: number[]): ThroughputStats {
  return {
    p10Mbps: percentile(samples, 10),
    p50Mbps: percentile(samples, 50),
    p90Mbps: percentile(samples, 90),
    sampleCount: samples.length
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
