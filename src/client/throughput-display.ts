import type { ThroughputStats } from "../shared/contracts";

export type IqrKeptDisplay = {
  value: string;
  detail: string;
};

export function iqrKeptDisplay(stats: Pick<ThroughputStats, "sampleCount" | "filteredSampleCount">): IqrKeptDisplay {
  return {
    value: `${stats.filteredSampleCount}/${stats.sampleCount}`,
    detail: `${formatOutlierRate(stats)} outliers`
  };
}

function formatOutlierRate(stats: Pick<ThroughputStats, "sampleCount" | "filteredSampleCount">): string {
  if (stats.sampleCount <= 0) return "0%";
  const outlierCount = Math.max(0, stats.sampleCount - stats.filteredSampleCount);
  if (outlierCount === 0) return "0%";
  return `${formatPercent((outlierCount / stats.sampleCount) * 100)}%`;
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}
