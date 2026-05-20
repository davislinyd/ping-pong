import type { ActiveTestsResponse, ReportContextResponse, RuntimeConfigResponse, SavedResult } from "../shared/contracts";
import type { CompletionSummary } from "./result-summary";
import type { MetricSeries } from "./speed-test-core";

export type ReportFormat = "html" | "png";

export type TransferMegabitsSnapshot = {
  download: number;
  upload: number;
};

export type ClientDiagnostics = {
  userAgent: string;
  userAgentData: string;
  platform: string;
  language: string;
  languages: string;
  timezone: string;
  screen: string;
  viewport: string;
  devicePixelRatio: string;
  hardwareConcurrency: string;
  deviceMemory: string;
  networkEffectiveType: string;
  networkDownlink: string;
  networkRtt: string;
  networkSaveData: string;
};

export type ClientDiagnosticsSource = {
  userAgent?: string | null;
  userAgentData?: UserAgentDataLike | null;
  platform?: string | null;
  language?: string | null;
  languages?: readonly string[] | null;
  timezone?: string | null;
  screenWidth?: number | null;
  screenHeight?: number | null;
  screenAvailableWidth?: number | null;
  screenAvailableHeight?: number | null;
  viewportWidth?: number | null;
  viewportHeight?: number | null;
  devicePixelRatio?: number | null;
  hardwareConcurrency?: number | null;
  deviceMemoryGb?: number | null;
  networkEffectiveType?: string | null;
  networkDownlinkMbps?: number | null;
  networkRttMs?: number | null;
  networkSaveData?: boolean | null;
};

export type ReportBuildInput = {
  savedResult: SavedResult;
  config: RuntimeConfigResponse;
  summary: CompletionSummary;
  activeStatus: ActiveTestsResponse;
  transferMegabits: TransferMegabitsSnapshot;
  metricSeries?: MetricSeries;
  context: ReportContextResponse | null;
  contextError?: string | null;
  appVersion: string;
  pageUrl: string;
  generatedAt?: Date;
  diagnostics?: ClientDiagnostics;
};

export type ReportSnapshot = {
  savedResult: SavedResult;
  config: RuntimeConfigResponse;
  summary: CompletionSummary;
  activeStatus: ActiveTestsResponse;
  transferMegabits: TransferMegabitsSnapshot;
  metricSeries: MetricSeries;
  context: ReportContextResponse | null;
  contextError: string | null;
  appVersion: string;
  pageUrl: string;
  generatedAt: string;
  diagnostics: ClientDiagnostics;
};

export type ReportRow = {
  label: string;
  value: string;
};

export type ReportSection = {
  title: string;
  rows: ReportRow[];
};

export type ReportChart = {
  label: string;
  unit: string;
  values: number[];
  latestValue: number;
};

type UserAgentDataLike = {
  brands?: Array<{ brand: string; version: string }>;
  mobile?: boolean;
  platform?: string;
};

type NavigatorWithDiagnostics = Navigator & {
  userAgentData?: UserAgentDataLike;
  deviceMemory?: number;
  connection?: {
    effectiveType?: string;
    downlink?: number;
    rtt?: number;
    saveData?: boolean;
  };
};

type CanvasTextContext = Pick<CanvasRenderingContext2D, "measureText">;

const unavailable = "Unavailable";
const reportWidth = 1080;
const reportMargin = 56;
const rowGap = 10;

export function buildReportSnapshot(input: ReportBuildInput): ReportSnapshot {
  return {
    savedResult: input.savedResult,
    config: input.config,
    summary: input.summary,
    activeStatus: input.activeStatus,
    transferMegabits: input.transferMegabits,
    metricSeries: input.metricSeries ?? metricSeriesFromResult(input.savedResult),
    context: input.context,
    contextError: input.contextError?.trim() || null,
    appVersion: input.appVersion,
    pageUrl: input.pageUrl,
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    diagnostics: input.diagnostics ?? collectClientDiagnostics()
  };
}

export function reportCharts(snapshot: ReportSnapshot): ReportChart[] {
  const result = snapshot.savedResult;
  return [
    {
      label: "Download",
      unit: "Mbps",
      values: chartValues(snapshot.metricSeries.downloadMbps, [result.downloadMbps]),
      latestValue: result.downloadMbps
    },
    {
      label: "Upload",
      unit: "Mbps",
      values: chartValues(snapshot.metricSeries.uploadMbps, [result.uploadMbps]),
      latestValue: result.uploadMbps
    },
    {
      label: "Idle Latency",
      unit: "ms",
      values: chartValues(snapshot.metricSeries.idleLatencyMs, [result.idleLatencyMs]),
      latestValue: result.idleLatencyMs
    },
    {
      label: "Loaded Latency",
      unit: "ms",
      values: chartValues(snapshot.metricSeries.loadedLatencyMs, [result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs]),
      latestValue: Math.max(result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs)
    },
    {
      label: "Jitter",
      unit: "ms",
      values: chartValues(snapshot.metricSeries.jitterMs, [result.jitterMs]),
      latestValue: result.jitterMs
    },
    {
      label: "HTTP Loss",
      unit: "%",
      values: chartValues(snapshot.metricSeries.httpLossPercent, [result.httpLossPercent]),
      latestValue: result.httpLossPercent
    }
  ];
}

export function collectClientDiagnostics(): ClientDiagnostics {
  const nav = window.navigator as NavigatorWithDiagnostics;
  const connection = nav.connection;

  return clientDiagnosticsFromSource({
    userAgent: nav.userAgent,
    userAgentData: nav.userAgentData,
    platform: nav.platform,
    language: nav.language,
    languages: nav.languages,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height,
    screenAvailableWidth: window.screen.availWidth,
    screenAvailableHeight: window.screen.availHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemoryGb: nav.deviceMemory,
    networkEffectiveType: connection?.effectiveType,
    networkDownlinkMbps: connection?.downlink,
    networkRttMs: connection?.rtt,
    networkSaveData: connection?.saveData
  });
}

export function clientDiagnosticsFromSource(source: ClientDiagnosticsSource = {}): ClientDiagnostics {
  return {
    userAgent: textValue(source.userAgent),
    userAgentData: userAgentDataText(source.userAgentData),
    platform: textValue(source.platform),
    language: textValue(source.language),
    languages: source.languages && source.languages.length > 0 ? source.languages.join(", ") : unavailable,
    timezone: textValue(source.timezone),
    screen: dimensionText(source.screenWidth, source.screenHeight, source.screenAvailableWidth, source.screenAvailableHeight, "available"),
    viewport: dimensionText(source.viewportWidth, source.viewportHeight),
    devicePixelRatio: numberText(source.devicePixelRatio),
    hardwareConcurrency: numberText(source.hardwareConcurrency, " logical threads"),
    deviceMemory: numberText(source.deviceMemoryGb, " GB"),
    networkEffectiveType: textValue(source.networkEffectiveType),
    networkDownlink: numberText(source.networkDownlinkMbps, " Mbps"),
    networkRtt: numberText(source.networkRttMs, " ms"),
    networkSaveData: booleanText(source.networkSaveData)
  };
}

export function reportSections(snapshot: ReportSnapshot): ReportSection[] {
  const result = snapshot.savedResult;
  const context = snapshot.context;
  const loadedLatency = Math.max(result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs);
  const activeLoadNote = snapshot.activeStatus.isFull
    ? "Full during report generation"
    : snapshot.activeStatus.isWarning
      ? "Multiple tests active during report generation"
      : "Normal at report generation";

  return [
    {
      title: "Summary",
      rows: [
        { label: "Verdict", value: snapshot.summary.title },
        { label: "Detail", value: snapshot.summary.subtitle },
        { label: "Primary limit", value: snapshot.summary.primaryLimit },
        { label: "Limiting side", value: snapshot.summary.limitingSide },
        { label: "Generated at", value: timestampText(snapshot.generatedAt) },
        { label: "Result ID", value: String(result.id) }
      ]
    },
    {
      title: "Speed Result",
      rows: [
        { label: "Download Mean", value: mbpsText(result.downloadStats.meanMbps) },
        {
          label: "Download P10 / P50 / P75 / P90",
          value: `${mbpsText(result.downloadStats.p10Mbps)} / ${mbpsText(result.downloadStats.p50Mbps)} / ${mbpsText(result.downloadStats.p75Mbps)} / ${mbpsText(result.downloadStats.p90Mbps)}`
        },
        { label: "Download CV / samples", value: `${percentText(result.downloadStats.cvPercent)} / ${result.downloadStats.sampleCount}` },
        { label: "Upload Mean", value: mbpsText(result.uploadStats.meanMbps) },
        {
          label: "Upload P10 / P50 / P75 / P90",
          value: `${mbpsText(result.uploadStats.p10Mbps)} / ${mbpsText(result.uploadStats.p50Mbps)} / ${mbpsText(result.uploadStats.p75Mbps)} / ${mbpsText(result.uploadStats.p90Mbps)}`
        },
        { label: "Upload CV / samples", value: `${percentText(result.uploadStats.cvPercent)} / ${result.uploadStats.sampleCount}` }
      ]
    },
    {
      title: "Quality Result",
      rows: [
        { label: "Idle latency", value: msText(result.idleLatencyMs) },
        { label: "Download loaded latency", value: msText(result.downloadLoadedLatencyMs) },
        { label: "Upload loaded latency", value: msText(result.uploadLoadedLatencyMs) },
        { label: "Worst loaded latency", value: msText(loadedLatency) },
        { label: "Jitter", value: msText(result.jitterMs) },
        { label: "HTTP loss", value: percentText(result.httpLossPercent) }
      ]
    },
    {
      title: "Test Setup",
      rows: [
        { label: "Server", value: result.serverName || snapshot.config.serverName },
        { label: "App version", value: `v${snapshot.appVersion}` },
        { label: "Page URL", value: snapshot.pageUrl },
        { label: "Completed at", value: timestampText(result.createdAt) },
        { label: "Duration", value: `${result.durationSeconds} seconds` },
        { label: "Parallel connections", value: String(result.parallelConnections) },
        { label: "Total download", value: megabitsText(snapshot.transferMegabits.download) },
        { label: "Total upload", value: megabitsText(snapshot.transferMegabits.upload) }
      ]
    },
    {
      title: "Active Test Load",
      rows: [
        { label: "Active tests", value: `${snapshot.activeStatus.activeTests}/${snapshot.activeStatus.maxActiveTests}` },
        { label: "Warning threshold", value: String(snapshot.activeStatus.warningThreshold) },
        { label: "Load note", value: activeLoadNote },
        { label: "Active status updated", value: timestampText(snapshot.activeStatus.updatedAt) }
      ]
    },
    {
      title: "Request Context",
      rows: [
        { label: "Client IP", value: context?.clientIp ?? unavailable },
        { label: "Coarse IP", value: context?.coarseIp ?? unavailable },
        { label: "IP source", value: context?.ipSource ?? unavailable },
        { label: "Trust proxy aware", value: context ? booleanText(context.trustProxyAware) : unavailable },
        { label: "Request host", value: context?.requestHost ?? unavailable },
        { label: "Request protocol", value: context?.requestProtocol ?? unavailable },
        { label: "Server time", value: context ? timestampText(context.serverTime) : unavailable },
        { label: "Server browser family", value: context?.browserFamily ?? result.browserFamily },
        { label: "Saved browser family", value: result.browserFamily },
        { label: "Anonymous client ID", value: result.clientId },
        { label: "Local self-test", value: context ? booleanText(context.clientSafety.isLocalClient) : booleanText(result.isLocalClient) },
        { label: "Client safety", value: context?.clientSafety.message ?? (result.isLocalClient ? "Local self-test result" : "No warning") },
        { label: "Context status", value: snapshot.contextError ? `Partial: ${snapshot.contextError}` : "Complete" }
      ]
    },
    {
      title: "Browser And Computer",
      rows: [
        { label: "User-Agent", value: snapshot.diagnostics.userAgent },
        { label: "UA Client Hints", value: snapshot.diagnostics.userAgentData },
        { label: "Platform", value: snapshot.diagnostics.platform },
        { label: "Language", value: snapshot.diagnostics.language },
        { label: "Languages", value: snapshot.diagnostics.languages },
        { label: "Timezone", value: snapshot.diagnostics.timezone },
        { label: "Screen", value: snapshot.diagnostics.screen },
        { label: "Viewport", value: snapshot.diagnostics.viewport },
        { label: "Device pixel ratio", value: snapshot.diagnostics.devicePixelRatio },
        { label: "CPU thread hint", value: snapshot.diagnostics.hardwareConcurrency },
        { label: "Device memory hint", value: snapshot.diagnostics.deviceMemory },
        { label: "Network effective type", value: snapshot.diagnostics.networkEffectiveType },
        { label: "Network downlink hint", value: snapshot.diagnostics.networkDownlink },
        { label: "Network RTT hint", value: snapshot.diagnostics.networkRtt },
        { label: "Network Save-Data", value: snapshot.diagnostics.networkSaveData }
      ]
    }
  ];
}

export async function downloadReport(snapshot: ReportSnapshot, format: ReportFormat): Promise<void> {
  if (format === "html") {
    const blob = new Blob([renderReportHtml(snapshot)], { type: "text/html;charset=utf-8" });
    triggerDownload(blob, reportFilename(snapshot, "html"));
    return;
  }

  const blob = await renderReportPngBlob(snapshot);
  triggerDownload(blob, reportFilename(snapshot, "png"));
}

export function renderReportHtml(snapshot: ReportSnapshot): string {
  const sections = reportSections(snapshot);
  const chartHtml = renderChartsHtml(reportCharts(snapshot));
  const sectionHtml = sections
    .map(
      (section) => `
        <section>
          <h2>${escapeHtml(section.title)}</h2>
          <table>
            <tbody>
              ${section.rows
                .map(
                  (row) => `
                    <tr>
                      <th>${escapeHtml(row.label)}</th>
                      <td>${escapeHtml(row.value)}</td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </section>
      `
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Ping Pong IT Diagnostic Report</title>
    <style>
      :root { color: #111827; background: #f8fafc; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { margin: 0; padding: 32px; }
      main { max-width: 980px; margin: 0 auto; border: 1px solid #dce4ea; border-radius: 8px; padding: 32px; background: #ffffff; box-shadow: 0 18px 44px rgba(38, 47, 56, 0.08); }
      h1 { margin: 0; font-size: 2rem; line-height: 1.1; }
      .meta { margin: 8px 0 28px; color: #64717d; font-weight: 700; }
      section { margin-top: 24px; }
      h2 { margin: 0 0 10px; color: #0f766e; font-size: 1rem; letter-spacing: 0; text-transform: uppercase; }
      .chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .chart-card { border: 1px solid #edf2f6; border-radius: 8px; padding: 12px; background: #f8fafc; }
      .chart-card-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
      .chart-card strong { color: #111827; font-size: 0.95rem; }
      .chart-card span { color: #64717d; font-size: 0.82rem; font-weight: 700; }
      .chart-svg { display: block; width: 100%; height: 120px; background: #ffffff; border: 1px solid #edf2f6; border-radius: 6px; }
      .chart-grid-line { stroke: #e5edf3; stroke-width: 1; }
      .chart-line { fill: none; stroke: #0f766e; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
      table { width: 100%; border-collapse: collapse; table-layout: fixed; border: 1px solid #edf2f6; }
      th, td { border-top: 1px solid #edf2f6; padding: 10px 12px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
      tr:first-child th, tr:first-child td { border-top: 0; }
      th { width: 230px; color: #64717d; background: #f8fafc; font-size: 0.9rem; }
      td { color: #111827; font-size: 0.95rem; }
      .note { margin-top: 28px; color: #64717d; font-size: 0.85rem; line-height: 1.5; }
      @media (max-width: 700px) {
        body { padding: 16px; }
        main { padding: 20px; }
        th, td { display: block; width: 100%; }
        td { border-top: 0; padding-top: 0; }
        .chart-grid { grid-template-columns: 1fr; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Ping Pong IT Diagnostic Report</h1>
      <p class="meta">Generated ${escapeHtml(timestampText(snapshot.generatedAt))}</p>
      ${chartHtml}
      ${sectionHtml}
      <p class="note">This report is generated only when the user downloads it. Raw IP and browser details are included in this file for IT evaluation and are not written to the saved results database by this export flow.</p>
    </main>
  </body>
</html>`;
}

export async function renderReportPngBlob(snapshot: ReportSnapshot): Promise<Blob> {
  const canvas = document.createElement("canvas");
  const initialContext = canvas.getContext("2d");
  if (!initialContext) {
    throw new Error("Canvas is unavailable in this browser.");
  }

  const sections = reportSections(snapshot);
  const charts = reportCharts(snapshot);
  const height = measureReportHeight(initialContext, sections, charts);
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = reportWidth * scale;
  canvas.height = height * scale;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Canvas is unavailable in this browser.");
  }

  context.scale(scale, scale);
  drawReportPng(context, snapshot, sections, charts, height);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("Failed to render PNG report."));
      }
    }, "image/png");
  });
}

export function wrapCanvasText(context: CanvasTextContext, value: string, maxWidth: number): string[] {
  const text = value.trim() || unavailable;
  const lines: string[] = [];

  for (const paragraph of text.split(/\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    let current = "";

    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth) {
        current = candidate;
        continue;
      }

      if (current) {
        lines.push(current);
      }

      if (context.measureText(word).width <= maxWidth) {
        current = word;
      } else {
        const chunks = breakLongWord(context, word, maxWidth);
        lines.push(...chunks.slice(0, -1));
        current = chunks[chunks.length - 1] ?? "";
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [unavailable];
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderChartsHtml(charts: ReportChart[]): string {
  const chartCards = charts
    .map((chart) => {
      const points = chartPolylinePoints(chart.values, 300, 120, 14, 16);
      return `
        <article class="chart-card">
          <div class="chart-card-head">
            <strong>${escapeHtml(chart.label)}</strong>
            <span>${escapeHtml(formatNumber(chart.latestValue))} ${escapeHtml(chart.unit)} / ${chart.values.length} samples</span>
          </div>
          <svg class="chart-svg" viewBox="0 0 300 120" preserveAspectRatio="none" role="img" aria-label="${escapeHtml(chart.label)} test chart">
            <line class="chart-grid-line" x1="0" y1="30" x2="300" y2="30"></line>
            <line class="chart-grid-line" x1="0" y1="60" x2="300" y2="60"></line>
            <line class="chart-grid-line" x1="0" y1="90" x2="300" y2="90"></line>
            <polyline class="chart-line" points="${escapeHtml(points)}"></polyline>
          </svg>
        </article>
      `;
    })
    .join("");

  return `
    <section>
      <h2>Test Charts</h2>
      <div class="chart-grid">
        ${chartCards}
      </div>
    </section>
  `;
}

function measureReportHeight(context: CanvasRenderingContext2D, sections: ReportSection[], charts: ReportChart[]): number {
  let y = 146;
  context.font = "700 15px system-ui, sans-serif";
  y += chartSectionHeight(charts);
  for (const section of sections) {
    y += 44;
    for (const row of section.rows) {
      const valueLines = wrapCanvasText(context, row.value, 650);
      y += Math.max(34, valueLines.length * 19 + 16) + rowGap;
    }
    y += 14;
  }
  return Math.ceil(y + 64);
}

function drawReportPng(context: CanvasRenderingContext2D, snapshot: ReportSnapshot, sections: ReportSection[], charts: ReportChart[], height: number): void {
  context.fillStyle = "#f8fafc";
  context.fillRect(0, 0, reportWidth, height);
  context.fillStyle = "#ffffff";
  roundedRect(context, 28, 28, reportWidth - 56, height - 56, 8);
  context.fill();
  context.strokeStyle = "#dce4ea";
  context.stroke();

  let y = 78;
  context.fillStyle = "#101418";
  context.font = "800 34px system-ui, sans-serif";
  context.fillText("Ping Pong IT Diagnostic Report", reportMargin, y);
  y += 30;
  context.fillStyle = "#64717d";
  context.font = "700 15px system-ui, sans-serif";
  context.fillText(`Generated ${timestampText(snapshot.generatedAt)}`, reportMargin, y);
  y += 30;

  y = drawChartSection(context, charts, y);

  for (const section of sections) {
    y += 22;
    context.fillStyle = "#0f766e";
    context.font = "800 17px system-ui, sans-serif";
    context.fillText(section.title.toUpperCase(), reportMargin, y);
    y += 18;

    for (const row of section.rows) {
      const rowHeight = drawReportRow(context, row, y);
      y += rowHeight + rowGap;
    }
  }

  context.fillStyle = "#64717d";
  context.font = "600 13px system-ui, sans-serif";
  const note = "Generated by the user's browser for IT evaluation. Raw IP and browser details are not stored by this export flow.";
  for (const line of wrapCanvasText(context, note, reportWidth - reportMargin * 2)) {
    context.fillText(line, reportMargin, y + 24);
    y += 18;
  }
}

function chartSectionHeight(charts: ReportChart[]): number {
  const cardHeight = 158;
  const rows = Math.ceil(charts.length / 2);
  return 22 + 18 + rows * cardHeight + Math.max(0, rows - 1) * 14 + 28;
}

function drawChartSection(context: CanvasRenderingContext2D, charts: ReportChart[], startY: number): number {
  let y = startY + 22;
  context.fillStyle = "#0f766e";
  context.font = "800 17px system-ui, sans-serif";
  context.fillText("TEST CHARTS", reportMargin, y);
  y += 18;

  const gap = 14;
  const cardHeight = 158;
  const cardWidth = (reportWidth - reportMargin * 2 - gap) / 2;

  charts.forEach((chart, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = reportMargin + column * (cardWidth + gap);
    const cardY = y + row * (cardHeight + gap);
    drawChartCard(context, chart, x, cardY, cardWidth, cardHeight);
  });

  return y + Math.ceil(charts.length / 2) * cardHeight + Math.max(0, Math.ceil(charts.length / 2) - 1) * gap + 28;
}

function drawChartCard(context: CanvasRenderingContext2D, chart: ReportChart, x: number, y: number, width: number, height: number): void {
  context.fillStyle = "#f8fafc";
  roundedRect(context, x, y, width, height, 8);
  context.fill();
  context.strokeStyle = "#edf2f6";
  context.stroke();

  context.fillStyle = "#111827";
  context.font = "800 15px system-ui, sans-serif";
  context.fillText(chart.label, x + 14, y + 26);

  context.fillStyle = "#64717d";
  context.font = "700 13px system-ui, sans-serif";
  const value = `${formatNumber(chart.latestValue)} ${chart.unit} / ${chart.values.length} samples`;
  context.fillText(value, x + 14, y + 46);

  const chartX = x + 14;
  const chartY = y + 60;
  const chartWidth = width - 28;
  const chartHeight = height - 76;
  context.fillStyle = "#ffffff";
  roundedRect(context, chartX, chartY, chartWidth, chartHeight, 6);
  context.fill();
  context.strokeStyle = "#edf2f6";
  context.stroke();

  context.strokeStyle = "#e5edf3";
  context.lineWidth = 1;
  for (const ratio of [0.25, 0.5, 0.75]) {
    const gridY = chartY + chartHeight * ratio;
    context.beginPath();
    context.moveTo(chartX, gridY);
    context.lineTo(chartX + chartWidth, gridY);
    context.stroke();
  }

  const points = chartPoints(chart.values, chartWidth, chartHeight, 8, 10).map(([pointX, pointY]) => [chartX + pointX, chartY + pointY] as const);
  context.strokeStyle = "#0f766e";
  context.lineWidth = 3;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  points.forEach(([pointX, pointY], index) => {
    if (index === 0) {
      context.moveTo(pointX, pointY);
    } else {
      context.lineTo(pointX, pointY);
    }
  });
  context.stroke();
  context.lineCap = "butt";
}

function drawReportRow(context: CanvasRenderingContext2D, row: ReportRow, y: number): number {
  const labelX = reportMargin + 16;
  const valueX = reportMargin + 260;
  const rowWidth = reportWidth - reportMargin * 2;
  const valueWidth = rowWidth - 292;

  context.font = "700 15px system-ui, sans-serif";
  const valueLines = wrapCanvasText(context, row.value, valueWidth);
  const rowHeight = Math.max(34, valueLines.length * 19 + 16);

  context.fillStyle = "#f8fafc";
  roundedRect(context, reportMargin, y, rowWidth, rowHeight, 6);
  context.fill();
  context.strokeStyle = "#edf2f6";
  context.stroke();

  context.fillStyle = "#64717d";
  context.font = "800 14px system-ui, sans-serif";
  context.fillText(row.label, labelX, y + 23);

  context.fillStyle = "#111827";
  context.font = "700 15px system-ui, sans-serif";
  valueLines.forEach((line, index) => {
    context.fillText(line, valueX, y + 23 + index * 19);
  });

  return rowHeight;
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

function breakLongWord(context: CanvasTextContext, word: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const character of word) {
    const candidate = `${current}${character}`;
    if (candidate && context.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
    }
    current = character;
  }
  if (current) {
    chunks.push(current);
  }
  return chunks;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function reportFilename(snapshot: ReportSnapshot, extension: "html" | "png"): string {
  const stamp = snapshot.generatedAt.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").replace("T", "-");
  return `ping-pong-report-${stamp}.${extension}`;
}

function metricSeriesFromResult(result: SavedResult): MetricSeries {
  return {
    downloadMbps: chartValues([], [result.downloadMbps]),
    uploadMbps: chartValues([], [result.uploadMbps]),
    idleLatencyMs: chartValues([], [result.idleLatencyMs]),
    loadedLatencyMs: chartValues([], [result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs]),
    jitterMs: chartValues([], [result.jitterMs]),
    httpLossPercent: chartValues([], [result.httpLossPercent])
  };
}

function chartValues(values: number[], fallback: number[]): number[] {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length > 0) {
    return filtered.slice(-120);
  }

  const fallbackValues = fallback.filter((value) => Number.isFinite(value));
  if (fallbackValues.length === 0) {
    return [0, 0];
  }
  if (fallbackValues.length === 1) {
    return [fallbackValues[0], fallbackValues[0]];
  }
  return fallbackValues;
}

function chartPolylinePoints(values: number[], width: number, height: number, paddingX: number, paddingY: number): string {
  return chartPoints(values, width, height, paddingX, paddingY)
    .map(([x, y]) => `${roundSvg(x)},${roundSvg(y)}`)
    .join(" ");
}

function chartPoints(values: number[], width: number, height: number, paddingX: number, paddingY: number): Array<[number, number]> {
  const safeValues = chartValues(values, [0]);
  const min = Math.min(...safeValues);
  const max = Math.max(...safeValues);
  const range = max - min;
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingY * 2;

  return safeValues.map((value, index) => {
    const x = paddingX + (plotWidth * index) / Math.max(1, safeValues.length - 1);
    const y = range === 0 ? height / 2 : paddingY + (1 - (value - min) / range) * plotHeight;
    return [x, y];
  });
}

function roundSvg(value: number): number {
  return Math.round(value * 100) / 100;
}

function userAgentDataText(value: UserAgentDataLike | null | undefined): string {
  if (!value) return unavailable;
  const brands = value.brands?.map((item) => `${item.brand} ${item.version}`).join(", ");
  const parts = [
    brands ? `brands: ${brands}` : null,
    value.platform ? `platform: ${value.platform}` : null,
    typeof value.mobile === "boolean" ? `mobile: ${value.mobile ? "yes" : "no"}` : null
  ].filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join("; ") : unavailable;
}

function dimensionText(width: number | null | undefined, height: number | null | undefined, availableWidth?: number | null, availableHeight?: number | null, availableLabel?: string): string {
  if (!finiteNumber(width) || !finiteNumber(height)) return unavailable;
  const primary = `${Math.round(width)} x ${Math.round(height)}`;
  if (finiteNumber(availableWidth) && finiteNumber(availableHeight) && availableLabel) {
    return `${primary}; ${availableLabel}: ${Math.round(availableWidth)} x ${Math.round(availableHeight)}`;
  }
  return primary;
}

function textValue(value: string | null | undefined): string {
  return value?.trim() || unavailable;
}

function numberText(value: number | null | undefined, suffix = ""): string {
  return finiteNumber(value) ? `${formatNumber(value)}${suffix}` : unavailable;
}

function booleanText(value: boolean | null | undefined): string {
  if (typeof value !== "boolean") return unavailable;
  return value ? "Yes" : "No";
}

function mbpsText(value: number): string {
  return `${formatNumber(value)} Mbps`;
}

function msText(value: number): string {
  return `${formatNumber(value)} ms`;
}

function percentText(value: number): string {
  return `${formatNumber(value)}%`;
}

function megabitsText(value: number): string {
  return `${formatNumber(value)} Mb`;
}

function timestampText(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailable;
  const pad = (item: number) => String(item).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offsetSign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (Number.isInteger(value)) return value.toFixed(0);
  if (Math.abs(value) >= 100) return value.toFixed(0);
  if (Math.abs(value) >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function finiteNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
