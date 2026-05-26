import { describe, expect, it } from "vitest";

import { buildRawDataRows, rawDataFilename, rawDataRowsToCsv, summarizeRawDataRows } from "../src/client/raw-data";
import type { RawTestData } from "../src/client/speed-test-core";

describe("raw data export helpers", () => {
  it("builds rows with used and excluded sample status labels", () => {
    const rows = buildRawDataRows(rawData(), { id: 42, createdAt: "2026-05-26T01:02:03.000Z" });
    const summary = summarizeRawDataRows(rows);

    expect(rows[0]).toMatchObject({
      test_id: "42",
      group: "Download Throughput",
      status: "startup-excluded",
      excluded_from: "Stable Mean; Stable CV; Raw CV; P10/P50/P75/P90"
    });
    expect(rows.some((row) => row.status === "iqr-excluded")).toBe(true);
    expect(rows.some((row) => row.status === "failed" && row.used_in === "HTTP Loss")).toBe(true);
    expect(summary.total).toBe(rows.length);
    expect(summary.excluded).toBeGreaterThan(0);
  });

  it("exports CSV with stable columns and escaped cells", () => {
    const rows = buildRawDataRows(rawData(), { id: 42, createdAt: "2026-05-26T01:02:03.000Z" });
    const csv = rawDataRowsToCsv(rows);

    expect(csv.split("\n")[0]).toBe("test_id,created_at,group,phase,sample_index,value,unit,status,reason,used_in,excluded_from,bytes,elapsed_ms");
    expect(csv).toContain("Stable Mean; Stable CV; Raw CV; P10/P50/P75/P90");
    expect(rawDataFilename("2026-05-26T01:02:03.000Z")).toBe("ping-pong-raw-data-20260526-010203Z.csv");
  });
});

function rawData(): RawTestData {
  return {
    downloadThroughput: [5, 100, 0, 100, 100, 100, 100, 100, 100, 1000].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    })),
    uploadThroughput: [10, 20, 30, 40].map((mbps) => ({
      bytes: mbps * 125_000,
      elapsedMs: 1000
    })),
    idleLatency: [3, 4, null],
    downloadLoadedLatency: [10, 11, 12, 13, 14, 15, 16, 17, 18, 1000],
    uploadLoadedLatency: [20, 22]
  };
}
