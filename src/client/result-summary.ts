import {
  DEFAULT_CAT_SPEED_RANGES,
  catSpeedStageForMbps,
  networkLinkTypeLabel,
  type CatSpeedRanges,
  type CatSpeedStage,
  type NetworkLinkType,
  type ResultPayload,
  type ThroughputStats
} from "../shared/contracts";
import { roundTo } from "../shared/metrics";

export type SummaryGrade = "excellent" | "good" | "fair" | "poor" | "unknown";
export type SummaryVerdict = Exclude<SummaryGrade, "unknown">;
export type SummaryLimit = "speed" | "stability" | "responsiveness" | "reliability";
export type LimitingSide = "download" | "upload" | "balanced";

export type SummaryTile = {
  label: string;
  value: string;
  detail: string;
  grade: SummaryGrade;
};

export type CompletionSummary = {
  verdict: SummaryVerdict;
  title: string;
  subtitle: string;
  primaryLimit: SummaryLimit;
  limitingSide: LimitingSide;
  networkLinkTypeLabel: string;
  tiles: SummaryTile[];
};

type ScoredLimit = {
  limit: SummaryLimit;
  grade: SummaryVerdict;
};

const gradeRank: Record<SummaryVerdict, number> = {
  excellent: 0,
  good: 1,
  fair: 2,
  poor: 3
};

const verdictTitles: Record<SummaryVerdict, string> = {
  excellent: "Excellent connection",
  good: "Good connection",
  fair: "Fair connection",
  poor: "Needs attention"
};

const speedStageLabels: Record<CatSpeedStage, string> = {
  idle: "Idle",
  walk: "Walk",
  jog: "Jog",
  run: "Run",
  sprint: "Sprint"
};

const speedStageGrades: Record<CatSpeedStage, SummaryVerdict> = {
  idle: "poor",
  walk: "poor",
  jog: "fair",
  run: "good",
  sprint: "excellent"
};

export function buildCompletionSummary(result: ResultPayload, ranges: CatSpeedRanges = DEFAULT_CAT_SPEED_RANGES): CompletionSummary {
  const speed = speedSummary(result, ranges);
  const stability = stabilitySummary(result.downloadStats, result.uploadStats, result.jitterMs);
  const responsiveness = responsivenessSummary(Math.max(result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs));
  const reliability = reliabilitySummary(result.httpLossPercent);
  const scored: ScoredLimit[] = [
    { limit: "reliability", grade: reliability.tile.grade as SummaryVerdict },
    ...(stability.tile.grade === "unknown" ? [] : [{ limit: "stability" as const, grade: stability.tile.grade }]),
    { limit: "responsiveness", grade: responsiveness.tile.grade as SummaryVerdict },
    ...(speed.tile.grade === "poor" ? [{ limit: "speed" as const, grade: speed.tile.grade }] : [])
  ];
  const worst = scored.reduce(
    (current, candidate) => (gradeRank[candidate.grade] > gradeRank[current.grade] ? candidate : current),
    scored[0] ?? { limit: "speed", grade: "excellent" }
  );

  return {
    verdict: worst.grade,
    title: verdictTitles[worst.grade],
    subtitle: summarySubtitle(worst, speed.limitingSide, stability.tile.grade, reliability.tile.grade, result.networkLinkType),
    primaryLimit: worst.limit,
    limitingSide: speed.limitingSide,
    networkLinkTypeLabel: networkLinkTypeLabel(result.networkLinkType),
    tiles: [speed.tile, stability.tile, responsiveness.tile, reliability.tile]
  };
}

function speedSummary(result: ResultPayload, ranges: CatSpeedRanges): { tile: SummaryTile; limitingSide: LimitingSide } {
  const download = safeMetric(result.downloadMbps);
  const upload = safeMetric(result.uploadMbps);
  const floorMbps = Math.min(download, upload);
  const stage = catSpeedStageForMbps(floorMbps, ranges);
  const limitingSide = limitingSideFor(download, upload);

  return {
    limitingSide,
    tile: {
      label: "Speed Tier",
      value: speedStageLabels[stage],
      detail: `${limitingSideDetail(limitingSide)} trimmed-mean floor ${formatMbps(floorMbps)}`,
      grade: speedStageGrades[stage]
    }
  };
}

function stabilitySummary(download: ThroughputStats, upload: ThroughputStats, jitterMs: number): { tile: SummaryTile; spread: number | null } {
  const rawCvValues = [stabilityRawCv(download), stabilityRawCv(upload)].filter((value): value is number => value !== null);
  if (rawCvValues.length === 0) {
    return {
      spread: null,
      tile: {
        label: "Stability",
        value: "Not enough samples",
        detail: "Needs 3+ samples per direction",
        grade: "unknown"
      }
    };
  }

  const rawCv = Math.max(...rawCvValues);
  const p10MeanRatio = minP10MeanRatio(download, upload);
  const outlierRate = maxOutlierRate(download, upload);
  const rawCvGrade = gradeByThreshold(rawCv, 10, 20, 35);
  const ratioGrade = p10MeanRatio === null ? "excellent" : gradeByMinimum(p10MeanRatio, 0.85, 0.7, 0.5);
  const outlierGrade = outlierRate === null ? "excellent" : gradeByThreshold(outlierRate, 2, 5, 10);
  const jitter = safeMetric(jitterMs);
  const jitterGrade = gradeByThreshold(jitter, 5, 15, 30);
  const grade = worstGrade([rawCvGrade, ratioGrade, outlierGrade, jitterGrade]);
  const value = grade === "poor" ? "Unstable" : grade === "fair" ? "Variable" : "Stable";

  return {
    spread: rawCv / 100,
    tile: {
      label: "Stability",
      value,
      detail: `${formatPercentValue(rawCv)} raw CV, P10/mean ${formatRatioPercent(p10MeanRatio)}, ${formatPercentValue(outlierRate ?? 0)} outliers, ${formatMs(jitter)} jitter`,
      grade
    }
  };
}

function responsivenessSummary(loadedLatencyMs: number): { tile: SummaryTile } {
  const latency = safeMetric(loadedLatencyMs);
  const grade = gradeByThreshold(latency, 50, 100, 200);
  const value = grade === "excellent" ? "Very responsive" : grade === "good" ? "Responsive" : grade === "fair" ? "Lag noticeable" : "High latency";

  return {
    tile: {
      label: "Responsiveness",
      value,
      detail: `${formatMs(latency)} loaded latency`,
      grade
    }
  };
}

function reliabilitySummary(httpLossPercent: number): { tile: SummaryTile } {
  const loss = safeMetric(httpLossPercent);
  const grade = loss === 0 ? "excellent" : loss <= 0.5 ? "good" : loss <= 2 ? "fair" : "poor";

  return {
    tile: {
      label: "Reliability",
      value: loss === 0 ? "Clean" : "Loss observed",
      detail: `${formatPercentValue(loss)} HTTP loss`,
      grade
    }
  };
}

function summarySubtitle(primary: ScoredLimit, limitingSide: LimitingSide, stabilityGrade: SummaryGrade, reliabilityGrade: SummaryGrade, networkLinkType: NetworkLinkType): string {
  if (primary.grade === "excellent") {
    return "Stable throughput - No packet loss";
  }

  const stabilityText =
    stabilityGrade === "unknown"
      ? "Stability needs more samples"
      : stabilityGrade === "poor"
        ? "Unstable throughput"
        : stabilityGrade === "fair"
          ? "Variable throughput"
          : "Stable throughput";

  if (primary.limit === "reliability") {
    return addLinkDiagnosis(`${reliabilityGrade === "excellent" ? "No packet loss" : "Loss observed"} - Reliability is the main limit`, networkLinkType);
  }

  if (primary.limit === "responsiveness") {
    return `${stabilityText} - Loaded latency is the main limit`;
  }

  if (primary.limit === "stability") {
    return addLinkDiagnosis(`${stabilityText} - Stability is the main limit`, networkLinkType);
  }

  if (limitingSide !== "balanced") {
    return `${stabilityText} - ${capitalize(limitingSide)} is the limiting side`;
  }

  return `${stabilityText} - No packet loss`;
}

function addLinkDiagnosis(subtitle: string, networkLinkType: NetworkLinkType): string {
  if (networkLinkType === "wifi") {
    return `${subtitle} - Retry on Wired to isolate the wireless segment`;
  }
  if (networkLinkType === "wired") {
    return `${subtitle} - Check switch, uplink, or server path`;
  }
  return subtitle;
}

function stabilityRawCv(stats: ThroughputStats): number | null {
  if (stats.sampleCount < 3 || !Number.isFinite(stats.rawCvPercent)) {
    return null;
  }

  return stats.rawCvPercent >= 0 ? stats.rawCvPercent : null;
}

function minP10MeanRatio(download: ThroughputStats, upload: ThroughputStats): number | null {
  const ratios = [p10MeanRatio(download), p10MeanRatio(upload)].filter((value): value is number => value !== null);
  return ratios.length > 0 ? Math.min(...ratios) : null;
}

function p10MeanRatio(stats: ThroughputStats): number | null {
  if (stats.sampleCount < 3 || !Number.isFinite(stats.p10Mbps) || !Number.isFinite(stats.meanMbps) || stats.meanMbps <= 0) {
    return null;
  }

  return Math.max(0, Math.min(1, stats.p10Mbps / stats.meanMbps));
}

function maxOutlierRate(download: ThroughputStats, upload: ThroughputStats): number | null {
  const rates = [outlierRate(download), outlierRate(upload)].filter((value): value is number => value !== null);
  return rates.length > 0 ? Math.max(...rates) : null;
}

function outlierRate(stats: ThroughputStats): number | null {
  if (stats.sampleCount < 3 || stats.filteredSampleCount < 0 || stats.filteredSampleCount > stats.sampleCount) {
    return null;
  }

  return ((stats.sampleCount - stats.filteredSampleCount) / stats.sampleCount) * 100;
}

function gradeByThreshold(value: number, excellentMax: number, goodMax: number, fairMax: number): SummaryVerdict {
  if (value <= excellentMax) return "excellent";
  if (value <= goodMax) return "good";
  if (value <= fairMax) return "fair";
  return "poor";
}

function gradeByMinimum(value: number, excellentMin: number, goodMin: number, fairMin: number): SummaryVerdict {
  if (value >= excellentMin) return "excellent";
  if (value >= goodMin) return "good";
  if (value >= fairMin) return "fair";
  return "poor";
}

function worseGrade(first: SummaryVerdict, second: SummaryVerdict): SummaryVerdict {
  return gradeRank[second] > gradeRank[first] ? second : first;
}

function worstGrade(grades: SummaryVerdict[]): SummaryVerdict {
  return grades.reduce((current, candidate) => worseGrade(current, candidate), "excellent");
}

function limitingSideFor(downloadMbps: number, uploadMbps: number): LimitingSide {
  const high = Math.max(downloadMbps, uploadMbps);
  const low = Math.min(downloadMbps, uploadMbps);
  if (high <= 0 || low / high > 0.8) return "balanced";
  return uploadMbps < downloadMbps ? "upload" : "download";
}

function limitingSideDetail(side: LimitingSide): string {
  if (side === "download") return "Download-limited";
  if (side === "upload") return "Upload-limited";
  return "Balanced";
}

function safeMetric(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatMbps(value: number): string {
  return `${formatNumber(value)} Mbps`;
}

function formatMs(value: number): string {
  return `${formatNumber(value)} ms`;
}

function formatPercent(spreadRatio: number): string {
  return `${formatNumber(spreadRatio * 100)}%`;
}

function formatPercentValue(value: number): string {
  return `${formatNumber(value)}%`;
}

function formatRatioPercent(value: number | null): string {
  return value === null ? "n/a" : `${formatNumber(value * 100)}%`;
}

function formatNumber(value: number): string {
  const rounded = roundTo(value, value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return rounded.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2 });
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
