import {
  DEFAULT_CAT_SPEED_RANGES,
  catSpeedStageForMbps,
  type CatSpeedRanges,
  type CatSpeedStage,
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
  const stability = stabilitySummary(result.downloadStats, result.uploadStats);
  const responsiveness = responsivenessSummary(Math.max(result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs));
  const reliability = reliabilitySummary(result.httpLossPercent);
  const scored: ScoredLimit[] = [
    { limit: "speed", grade: speed.tile.grade as SummaryVerdict },
    { limit: "responsiveness", grade: responsiveness.tile.grade as SummaryVerdict },
    { limit: "reliability", grade: reliability.tile.grade as SummaryVerdict },
    ...(stability.tile.grade === "unknown" ? [] : [{ limit: "stability" as const, grade: stability.tile.grade }])
  ];
  const worst = scored.reduce(
    (current, candidate) => (gradeRank[candidate.grade] > gradeRank[current.grade] ? candidate : current),
    scored[0] ?? { limit: "speed", grade: "excellent" }
  );

  return {
    verdict: worst.grade,
    title: verdictTitles[worst.grade],
    subtitle: summarySubtitle(worst.limit, speed.limitingSide, stability.tile.grade, reliability.tile.grade),
    primaryLimit: worst.limit,
    limitingSide: speed.limitingSide,
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
      detail: `${limitingSideDetail(limitingSide)} P50 floor ${formatMbps(floorMbps)}`,
      grade: speedStageGrades[stage]
    }
  };
}

function stabilitySummary(download: ThroughputStats, upload: ThroughputStats): { tile: SummaryTile; spread: number | null } {
  const spreads = [stabilitySpread(download), stabilitySpread(upload)].filter((value): value is number => value !== null);
  if (spreads.length === 0) {
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

  const spread = Math.max(...spreads);
  const grade = gradeByThreshold(spread, 0.3, 0.6, 1);
  const value = grade === "poor" ? "Unstable" : grade === "fair" ? "Variable" : "Stable";

  return {
    spread,
    tile: {
      label: "Stability",
      value,
      detail: `${formatPercent(spread)} P10-P90 spread`,
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

function summarySubtitle(primaryLimit: SummaryLimit, limitingSide: LimitingSide, stabilityGrade: SummaryGrade, reliabilityGrade: SummaryGrade): string {
  const stabilityText =
    stabilityGrade === "unknown"
      ? "Stability needs more samples"
      : stabilityGrade === "poor"
        ? "Unstable throughput"
        : stabilityGrade === "fair"
          ? "Variable throughput"
          : "Stable throughput";

  if (primaryLimit === "reliability") {
    return `${reliabilityGrade === "excellent" ? "No packet loss" : "Loss observed"} - Reliability is the main limit`;
  }

  if (primaryLimit === "responsiveness") {
    return `${stabilityText} - Loaded latency is the main limit`;
  }

  if (primaryLimit === "stability") {
    return `${stabilityText} - Stability is the main limit`;
  }

  if (limitingSide !== "balanced") {
    return `${stabilityText} - ${capitalize(limitingSide)} is the limiting side`;
  }

  return `${stabilityText} - No packet loss`;
}

function stabilitySpread(stats: ThroughputStats): number | null {
  if (stats.sampleCount < 3 || stats.p50Mbps <= 0 || !Number.isFinite(stats.p50Mbps)) {
    return null;
  }

  const spread = (stats.p90Mbps - stats.p10Mbps) / stats.p50Mbps;
  return Number.isFinite(spread) && spread >= 0 ? spread : null;
}

function gradeByThreshold(value: number, excellentMax: number, goodMax: number, fairMax: number): SummaryVerdict {
  if (value <= excellentMax) return "excellent";
  if (value <= goodMax) return "good";
  if (value <= fairMax) return "fair";
  return "poor";
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

function formatNumber(value: number): string {
  const rounded = roundTo(value, value >= 100 ? 0 : value >= 10 ? 1 : 2);
  return rounded.toLocaleString("en-US", { maximumFractionDigits: value >= 100 ? 0 : value >= 10 ? 1 : 2 });
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
