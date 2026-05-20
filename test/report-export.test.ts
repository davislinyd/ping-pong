import { describe, expect, it } from "vitest";

import { DEFAULT_CAT_SPEED_RANGES, type ActiveTestsResponse, type ReportContextResponse, type RuntimeConfigResponse, type SavedResult } from "../src/shared/contracts";
import type { CompletionSummary } from "../src/client/result-summary";
import {
  buildReportSnapshot,
  clientDiagnosticsFromSource,
  escapeHtml,
  renderReportHtml,
  reportCharts,
  reportSections,
  wrapCanvasText
} from "../src/client/report-export";

describe("IT diagnostic report export", () => {
  it("escapes report HTML values", () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe("&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;");

    const snapshot = buildReportSnapshot({
      savedResult: baseSavedResult({ serverName: "Node <A>" }),
      config: baseConfig(),
      summary: baseSummary(),
      activeStatus: baseActiveStatus(),
      transferMegabits: { download: 1200, upload: 650 },
      context: null,
      contextError: "Context <offline>",
      appVersion: "0.1.0",
      pageUrl: "http://example.test/?q=<bad>",
      generatedAt: new Date("2026-05-14T04:05:06.000Z"),
      diagnostics: clientDiagnosticsFromSource({ userAgent: `UA "quoted" <tag>` })
    });

    const html = renderReportHtml(snapshot);
    expect(html).toContain("Node &lt;A&gt;");
    expect(html).toContain("http://example.test/?q=&lt;bad&gt;");
    expect(html).toContain("UA &quot;quoted&quot; &lt;tag&gt;");
    expect(html).not.toContain("<bad>");
    expect(html).not.toContain("<tag>");
  });

  it("uses Unavailable for optional browser diagnostics", () => {
    const diagnostics = clientDiagnosticsFromSource();

    expect(diagnostics.userAgent).toBe("Unavailable");
    expect(diagnostics.userAgentData).toBe("Unavailable");
    expect(diagnostics.screen).toBe("Unavailable");
    expect(diagnostics.networkDownlink).toBe("Unavailable");
  });

  it("builds report sections from result, request context, and diagnostics", () => {
    const context: ReportContextResponse = {
      serverTime: "2026-05-14T04:06:00.000Z",
      serverName: "Test Node",
      requestHost: "ping-pong.test",
      requestProtocol: "http",
      clientIp: "10.0.5.23",
      coarseIp: "ipv4:10.0.5.0",
      ipSource: "direct-request-ip",
      trustProxyAware: false,
      browserFamily: "Chrome",
      clientSafety: {
        isLocalClient: false,
        canRunTest: true,
        reason: null,
        message: null
      }
    };
    const snapshot = buildReportSnapshot({
      savedResult: baseSavedResult(),
      config: baseConfig(),
      summary: baseSummary(),
      activeStatus: baseActiveStatus({ activeTests: 2, isWarning: true }),
      transferMegabits: { download: 1200, upload: 650 },
      context,
      appVersion: "0.1.0",
      pageUrl: "http://ping-pong.test/",
      generatedAt: new Date("2026-05-14T04:05:06.000Z"),
      diagnostics: clientDiagnosticsFromSource({
        userAgent: "Mozilla/5.0 Chrome/120.0",
        platform: "macOS",
        viewportWidth: 1280,
        viewportHeight: 900,
        hardwareConcurrency: 10
      })
    });

    const sections = reportSections(snapshot);
    expect(findRow(sections, "Client IP")?.value).toBe("10.0.5.23");
    expect(findRow(sections, "Coarse IP")?.value).toBe("ipv4:10.0.5.0");
    expect(findRow(sections, "Load note")?.value).toContain("Multiple tests active");
    expect(findRow(sections, "CPU thread hint")?.value).toBe("10 logical threads");
  });

  it("includes test charts in HTML reports from metric series", () => {
    const snapshot = buildReportSnapshot({
      savedResult: baseSavedResult(),
      config: baseConfig(),
      summary: baseSummary(),
      activeStatus: baseActiveStatus(),
      transferMegabits: { download: 1200, upload: 650 },
      metricSeries: {
        downloadMbps: [100, 180, 240, 420],
        uploadMbps: [60, 90, 140, 180],
        idleLatencyMs: [5, 4, 4.5],
        loadedLatencyMs: [22, 28, 35],
        jitterMs: [1, 1.1, 1.2],
        httpLossPercent: [0, 0, 0]
      },
      context: null,
      appVersion: "0.1.0",
      pageUrl: "http://ping-pong.test/",
      generatedAt: new Date("2026-05-14T04:05:06.000Z"),
      diagnostics: clientDiagnosticsFromSource()
    });

    const html = renderReportHtml(snapshot);
    const charts = reportCharts(snapshot);

    expect(html).toContain("Test Charts");
    expect(html).toContain("class=\"chart-svg\"");
    expect(html).toContain("Download test chart");
    expect(html).toContain("<polyline class=\"chart-line\"");
    expect(charts.find((chart) => chart.label === "Download")?.values).toEqual([100, 180, 240, 420]);
  });

  it("wraps long canvas text without overflowing the requested width", () => {
    const context = {
      measureText: (value: string) => ({ width: value.length * 8 })
    } as Parameters<typeof wrapCanvasText>[0];

    const lines = wrapCanvasText(context, "averyveryverylongunbrokenvalue normal words", 80);

    expect(lines.length).toBeGreaterThan(2);
    expect(lines.every((line) => context.measureText(line).width <= 80)).toBe(true);
  });
});

function findRow(sections: ReturnType<typeof reportSections>, label: string) {
  return sections.flatMap((section) => section.rows).find((row) => row.label === label);
}

function baseConfig(): RuntimeConfigResponse {
  return {
    serverName: "Test Node",
    defaultTestDurationSeconds: 15,
    parallelConnections: 4,
    maxTestBytes: 67_108_864,
    catSpeedRanges: DEFAULT_CAT_SPEED_RANGES,
    clientSafety: {
      isLocalClient: false,
      canRunTest: true,
      reason: null,
      message: null
    }
  };
}

function baseActiveStatus(patch: Partial<ActiveTestsResponse> = {}): ActiveTestsResponse {
  return {
    activeTests: 1,
    warningThreshold: 2,
    maxActiveTests: 4,
    isWarning: false,
    isFull: false,
    updatedAt: "2026-05-14T04:04:00.000Z",
    ...patch
  };
}

function baseSavedResult(patch: Partial<SavedResult> = {}): SavedResult {
  return {
    id: 42,
    createdAt: "2026-05-14T04:03:00.000Z",
    serverName: "Test Node",
    browserFamily: "Chrome",
    clientId: "abcdef1234567890abcd",
    isLocalClient: false,
    downloadMbps: 420,
    uploadMbps: 180,
    downloadStats: { meanMbps: 420, p10Mbps: 390, p50Mbps: 420, p75Mbps: 440, p90Mbps: 460, cvPercent: 6.5, sampleCount: 42, filteredSampleCount: 40 },
    uploadStats: { meanMbps: 180, p10Mbps: 150, p50Mbps: 180, p75Mbps: 195, p90Mbps: 210, cvPercent: 12, sampleCount: 40, filteredSampleCount: 38 },
    idleLatencyMs: 4.5,
    downloadLoadedLatencyMs: 25,
    uploadLoadedLatencyMs: 35,
    jitterMs: 1.2,
    httpLossPercent: 0,
    durationSeconds: 15,
    parallelConnections: 4,
    ...patch
  };
}

function baseSummary(): CompletionSummary {
  return {
    verdict: "good",
    title: "Good connection",
    subtitle: "Stable throughput - Upload is the limiting side",
    primaryLimit: "speed",
    limitingSide: "upload",
    tiles: [
      { label: "Speed Tier", value: "Run", detail: "Upload-limited P50 floor 180 Mbps", grade: "good" },
      { label: "Stability", value: "Stable", detail: "20% P10-P90 spread", grade: "excellent" },
      { label: "Responsiveness", value: "Responsive", detail: "35 ms loaded latency", grade: "good" },
      { label: "Reliability", value: "Clean", detail: "0% HTTP loss", grade: "excellent" }
    ]
  };
}
