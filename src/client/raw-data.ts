import type { SavedResult } from "../shared/contracts";
import { classifyLatencySamples, classifyThroughputSamples, type ClassifiedLatencySample, type ClassifiedThroughputSample } from "../shared/metrics";
import type { RawTestData } from "./speed-test-core";

export const RAW_DATA_CSV_COLUMNS = [
  "test_id",
  "created_at",
  "group",
  "phase",
  "sample_index",
  "value",
  "unit",
  "status",
  "reason",
  "used_in",
  "excluded_from",
  "bytes",
  "elapsed_ms"
] as const;

export type RawDataCsvColumn = (typeof RAW_DATA_CSV_COLUMNS)[number];

export type RawDataRow = Record<RawDataCsvColumn, string>;

export type RawDataSummary = {
  total: number;
  used: number;
  excluded: number;
};

type RawDataResultContext = Pick<SavedResult, "id" | "createdAt">;

export function buildRawDataRows(rawData: RawTestData, result: RawDataResultContext): RawDataRow[] {
  return [
    ...throughputRows("Download Throughput", "download", rawData.downloadThroughput, result),
    ...throughputRows("Upload Throughput", "upload", rawData.uploadThroughput, result),
    ...latencyRows("Idle Latency", "latency", "Idle Latency Median", rawData.idleLatency, result),
    ...latencyRows("Download Loaded Latency", "download", "Download Loaded Latency Median", rawData.downloadLoadedLatency, result),
    ...latencyRows("Upload Loaded Latency", "upload", "Upload Loaded Latency Median", rawData.uploadLoadedLatency, result)
  ];
}

export function summarizeRawDataRows(rows: RawDataRow[]): RawDataSummary {
  const used = rows.filter((row) => row.status === "used").length;
  return {
    total: rows.length,
    used,
    excluded: rows.length - used
  };
}

export function rawDataRowsToCsv(rows: RawDataRow[]): string {
  return [RAW_DATA_CSV_COLUMNS.join(","), ...rows.map((row) => RAW_DATA_CSV_COLUMNS.map((column) => csvCell(row[column])).join(","))].join("\n");
}

export function downloadRawDataCsv(rows: RawDataRow[], createdAt: string): void {
  const blob = new Blob([rawDataRowsToCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = rawDataFilename(createdAt);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function rawDataFilename(createdAt: string): string {
  const date = new Date(createdAt);
  const stamp = Number.isFinite(date.getTime())
    ? date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-")
    : new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `ping-pong-raw-data-${stamp}.csv`;
}

function throughputRows(group: string, phase: string, samples: RawTestData["downloadThroughput"], result: RawDataResultContext): RawDataRow[] {
  return classifyThroughputSamples(samples).map((sample) => throughputRow(group, phase, sample, result));
}

function throughputRow(group: string, phase: string, sample: ClassifiedThroughputSample, result: RawDataResultContext): RawDataRow {
  return {
    test_id: String(result.id),
    created_at: result.createdAt,
    group,
    phase,
    sample_index: String(sample.sampleIndex),
    value: formatRawNumber(sample.mbps),
    unit: "Mbps",
    status: sample.status,
    reason: sample.reason,
    used_in: sample.usedIn.join("; "),
    excluded_from: sample.excludedFrom.join("; "),
    bytes: String(sample.bytes),
    elapsed_ms: formatRawNumber(sample.elapsedMs)
  };
}

function latencyRows(group: string, phase: string, medianLabel: string, samples: Array<number | null>, result: RawDataResultContext): RawDataRow[] {
  return classifyLatencySamples(samples, medianLabel).map((sample) => latencyRow(group, phase, sample, result));
}

function latencyRow(group: string, phase: string, sample: ClassifiedLatencySample, result: RawDataResultContext): RawDataRow {
  return {
    test_id: String(result.id),
    created_at: result.createdAt,
    group,
    phase,
    sample_index: String(sample.sampleIndex),
    value: sample.ms === null ? "" : formatRawNumber(sample.ms),
    unit: "ms",
    status: sample.status,
    reason: sample.reason,
    used_in: sample.usedIn.join("; "),
    excluded_from: sample.excludedFrom.join("; "),
    bytes: "",
    elapsed_ms: ""
  };
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatRawNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  return String(Math.round(value * 100) / 100);
}
