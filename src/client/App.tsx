import {
  Activity,
  ArrowDown,
  ArrowUp,
  Cable,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  FileText,
  Image,
  Loader2,
  Radio,
  RotateCw,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UsersRound,
  Wifi,
  X
} from "lucide-react";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";

import {
  networkLinkTypeLabel,
  type NetworkLinkType,
  type ReportContextResponse,
  type ResultPayload,
  type RuntimeConfigResponse,
  type SavedResult,
  type ThroughputStats
} from "../shared/contracts";
import {
  deleteRecentResults,
  loadRecentResults,
  loadReportContext,
  loadRuntimeConfig,
  saveResult,
  type RawTestData,
  type TestPhase
} from "./speed-test";
import { AdminConsole } from "./AdminConsole";
import { buildRawDataRows, downloadRawDataCsv, summarizeRawDataRows, type RawDataRow } from "./raw-data";
import { buildCompletionSummary, type CompletionSummary } from "./result-summary";
import { buildReportSnapshot, downloadReport, type ReportFormat } from "./report-export";
import { isSpeedTestWorkerAbort } from "./speed-test-worker-client";
import { iqrKeptDisplay } from "./throughput-display";
import { useActiveSession } from "./hooks/useActiveSession";
import { useSpeedTest } from "./hooks/useSpeedTest";

type MetricTone = "teal" | "amber" | "blue" | "rose" | "ink" | "green";
type WarningNoticeKind = "hotspot" | "local" | "capacity";
type SelectableNetworkLinkType = Exclude<NetworkLinkType, "unknown">;
type ConnectionContextState = {
  status: "loading" | "ready" | "unavailable";
  context: ReportContextResponse | null;
};
const TEST_DURATIONS = [20, 30] as const;
type TestDurationSeconds = (typeof TEST_DURATIONS)[number];
const DEFAULT_TEST_DURATION_SECONDS: TestDurationSeconds = 20;

type Metric = {
  label: string;
  value: string;
  unit: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  tone: MetricTone;
  series: number[];
  stats?: ThroughputStats;
};
type WarningNotice = {
  key: WarningNoticeKind;
  kind: WarningNoticeKind;
  title: string;
  message: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  badge?: string;
  isFull?: boolean;
};

declare const __APP_VERSION__: string;

export function App() {
  return window.location.pathname === "/admin" ? <AdminConsole /> : <SpeedTestApp />;
}

function SpeedTestApp() {
  const appShellRef = useRef<HTMLElement | null>(null);
  const [config, setConfig] = useState<RuntimeConfigResponse | null>(null);
  const [recent, setRecent] = useState<SavedResult[]>([]);
  const [lastSavedResult, setLastSavedResult] = useState<SavedResult | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportBusyFormat, setReportBusyFormat] = useState<ReportFormat | null>(null);
  const [selectedMetricLabel, setSelectedMetricLabel] = useState<string | null>(null);
  const [selectedHistoryResult, setSelectedHistoryResult] = useState<SavedResult | null>(null);
  const [rawDataOpen, setRawDataOpen] = useState(false);
  const [speedGuideOpen, setSpeedGuideOpen] = useState(false);
  const [selectedNetworkLinkType, setSelectedNetworkLinkType] = useState<SelectableNetworkLinkType | null>(null);
  const [selectedTestDurationSeconds, setSelectedTestDurationSeconds] = useState<TestDurationSeconds>(DEFAULT_TEST_DURATION_SECONDS);
  const [connectionContext, setConnectionContext] = useState<ConnectionContextState>({ status: "loading", context: null });
  const [isDeletingRecent, setIsDeletingRecent] = useState(false);
  const [activeNoticeIndex, setActiveNoticeIndex] = useState(0);
  const [viewportLayoutMode, setViewportLayoutMode] = useState<"fit" | "scroll">("fit");
  const adminEntryClickCountRef = useRef(0);
  const adminEntryResetTimerRef = useRef<number | null>(null);

  const speedTest = useSpeedTest();
  const session = useActiveSession();

  const { phase, result, currentMbps, progressPercent, metricSeries, rawData, transferMegabits, error, isRunning } = speedTest;
  const { activeStatus } = session;

  const isSpeedPhase = phase === "download" || phase === "upload";
  const mainDisplayValue = isSpeedPhase && currentMbps === null ? "--" : formatNumber(isSpeedPhase && currentMbps !== null ? currentMbps : result.downloadMbps);
  const roundedProgress = Math.round(progressPercent);
  const localClientWarning = config?.clientSafety.isLocalClient ? config.clientSafety.message : null;
  const localThrottleActive = config?.localThrottle.active ?? false;
  const testBlocked = config ? !config.clientSafety.canRunTest : false;
  const activeTests = activeStatus.activeTests;
  const concurrencyFull = !testBlocked && activeStatus.isFull;
  const concurrencyWarning = !testBlocked && activeStatus.isWarning;
  const actionNeedsNetworkLinkType = !selectedNetworkLinkType && !testBlocked && !concurrencyFull && !isRunning;
  const needsNetworkLinkType = actionNeedsNetworkLinkType && phase !== "complete" && phase !== "error";
  const mainReadoutTone: MetricTone = phase === "upload" ? "amber" : "teal";
  const mainReadoutSeries = phase === "upload" ? metricSeries.uploadMbps : metricSeries.downloadMbps;
  const completionSummary = useMemo(() => buildCompletionSummary(result, config?.catSpeedRanges), [config?.catSpeedRanges, result]);
  const warningNotices = useMemo<WarningNotice[]>(() => {
    const notices: WarningNotice[] = [
      {
        key: "hotspot",
        kind: "hotspot",
        title: "Mobile hotspot data warning",
        message: "Hotspot testing may use significant mobile data.",
        icon: TriangleAlert
      }
    ];

    if (localClientWarning) {
      notices.push({
        key: "local",
        kind: "local",
        title: "Local self-test detected",
        message: `Local self-test only; open from another device for real intranet results.${
          localThrottleActive ? ` Traffic capped at ${config?.localThrottle.maxMbps} Mbps for maintenance.` : ""
        }`,
        icon: TriangleAlert,
        badge: localThrottleActive ? "Local throttled" : undefined
      });
    }

    if (concurrencyWarning) {
      notices.push({
        key: "capacity",
        kind: "capacity",
        title: concurrencyFull ? "Test capacity is full" : "Multiple active tests detected",
        message: concurrencyFull
          ? `All ${activeStatus.maxActiveTests} test slots are in use; try again after another test finishes.`
          : `${activeTests} active tests may affect results until they finish.`,
        icon: UsersRound,
        isFull: concurrencyFull
      });
    }

    return notices;
  }, [activeStatus.maxActiveTests, activeTests, concurrencyFull, concurrencyWarning, config?.localThrottle.maxMbps, localClientWarning, localThrottleActive]);

  useEffect(() => {
    void Promise.all([loadRuntimeConfig(), loadRecentResults(), refreshConnectionContext()])
      .then(([runtimeConfig, recentResults]) => {
        setConfig(runtimeConfig);
        setRecent(recentResults);
      })
      .catch((loadError) => {
        speedTest.setError(loadError instanceof Error ? loadError.message : "Failed to load");
        speedTest.setPhase("error");
      });
  }, []);

  useEffect(() => {
    if (!selectedMetricLabel && !selectedHistoryResult && !rawDataOpen && !speedGuideOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedMetricLabel(null);
        setSelectedHistoryResult(null);
        setRawDataOpen(false);
        setSpeedGuideOpen(false);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedMetricLabel, selectedHistoryResult, rawDataOpen, speedGuideOpen]);

  useEffect(() => {
    setActiveNoticeIndex((index) => Math.min(index, Math.max(warningNotices.length - 1, 0)));
  }, [warningNotices.length]);

  const syncViewportLayoutMode = useEffectEvent(() => {
    const shell = appShellRef.current;
    if (!shell) return;
    const nextMode = shell.scrollHeight > window.innerHeight + 1 ? "scroll" : "fit";
    setViewportLayoutMode((currentMode) => (currentMode === nextMode ? currentMode : nextMode));
  });

  useEffect(() => {
    let frame = window.requestAnimationFrame(syncViewportLayoutMode);

    function handleResize() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(syncViewportLayoutMode);
    }

    window.addEventListener("resize", handleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);
    };
  }, [syncViewportLayoutMode]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(syncViewportLayoutMode);
    return () => window.cancelAnimationFrame(frame);
  });

  const metrics = useMemo<Metric[]>(
    () => [
      {
        label: "Download",
        value: formatNumber(result.downloadMbps),
        unit: "Mbps",
        icon: ArrowDown,
        tone: "teal",
        series: metricSeries.downloadMbps,
        stats: result.downloadStats
      },
      {
        label: "Upload",
        value: formatNumber(result.uploadMbps),
        unit: "Mbps",
        icon: ArrowUp,
        tone: "amber",
        series: metricSeries.uploadMbps,
        stats: result.uploadStats
      },
      {
        label: "Idle Latency",
        value: formatNumber(result.idleLatencyMs),
        unit: "ms",
        icon: Clock3,
        tone: "blue",
        series: metricSeries.idleLatencyMs
      },
      {
        label: "Loaded Latency",
        value: formatNumber(Math.max(result.downloadLoadedLatencyMs, result.uploadLoadedLatencyMs)),
        unit: "ms",
        icon: Activity,
        tone: "rose",
        series: metricSeries.loadedLatencyMs
      },
      {
        label: "Jitter",
        value: formatNumber(result.jitterMs),
        unit: "ms",
        icon: Radio,
        tone: "ink",
        series: metricSeries.jitterMs
      },
      {
        label: "HTTP Loss",
        value: formatNumber(result.httpLossPercent),
        unit: "%",
        icon: ShieldCheck,
        tone: "green",
        series: metricSeries.httpLossPercent
      }
    ],
    [metricSeries, result]
  );

  async function startTest() {
    if (!config || isRunning || testBlocked || concurrencyFull || !selectedNetworkLinkType) return;

    const networkLinkType = selectedNetworkLinkType;
    speedTest.terminate();
    speedTest.setError(null);
    setLastSavedResult(null);
    setReportError(null);
    setRawDataOpen(false);

    let sessionId: string | null = null;
    try {
      const [runtimeConfig] = await Promise.all([loadRuntimeConfig(), refreshConnectionContext()]);
      const runConfig = { ...runtimeConfig, defaultTestDurationSeconds: selectedTestDurationSeconds };
      setConfig(runConfig);
      if (!runtimeConfig.clientSafety.canRunTest) {
        speedTest.setError(runtimeConfig.clientSafety.message ?? "This client is blocked from running speed tests.");
        speedTest.setPhase("error");
        setSelectedNetworkLinkType(null);
        return;
      }

      const activeSession = await session.beginSession();
      sessionId = activeSession.sessionId;

      const { measured, runId } = await speedTest.run(runConfig, networkLinkType);

      if (speedTest.isCurrentRun(runId)) {
        speedTest.setPhase("saving");
      }
      const saved = await saveResult(measured);
      if (speedTest.isCurrentRun(runId)) {
        setLastSavedResult(saved);
        setRecent((items) => [saved, ...items.filter((item) => item.id !== saved.id)].slice(0, 50));
        speedTest.setPhase("complete");
        setSelectedNetworkLinkType(null);
      }
    } catch (runError) {
      if (isSpeedTestWorkerAbort(runError)) return;
      speedTest.setError(runError instanceof Error ? runError.message : "Test failed");
      speedTest.setPhase("error");
      setSelectedNetworkLinkType(null);
    } finally {
      if (sessionId) {
        await session.closeSession(sessionId);
      }
    }
  }

  async function refreshConnectionContext() {
    try {
      const context = await loadReportContext();
      setConnectionContext({ status: "ready", context });
      return context;
    } catch {
      setConnectionContext({ status: "unavailable", context: null });
      return null;
    }
  }

  const buttonLabel = actionNeedsNetworkLinkType ? "Select Link" : phase === "complete" || phase === "error" ? "Retest" : "Start";
  const primaryMetrics = metrics.slice(0, 2);
  const secondaryMetrics = metrics.slice(2);
  const selectedMetric = selectedMetricLabel ? (metrics.find((metric) => metric.label === selectedMetricLabel) ?? null) : null;

  function handleAdminEntryClick() {
    stopAdminEntryResetTimer();

    const nextClickCount = adminEntryClickCountRef.current + 1;
    if (nextClickCount >= 5) {
      adminEntryClickCountRef.current = 0;
      window.location.assign("/admin");
      return;
    }

    adminEntryClickCountRef.current = nextClickCount;
    adminEntryResetTimerRef.current = window.setTimeout(() => {
      adminEntryClickCountRef.current = 0;
      adminEntryResetTimerRef.current = null;
    }, 1500);
  }

  return (
    <main className={`app-shell${viewportLayoutMode === "scroll" ? " app-shell-scroll-safe" : ""}`} ref={appShellRef}>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Wifi size={22} strokeWidth={2.3} />
          </span>
          <div>
            <p className="eyebrow">Ping Pong</p>
            <h1>Intranet Speed Test</h1>
          </div>
        </div>
        <div className="topbar-status">
          <div className={`server-pill active-pill${activeStatus.isFull ? " is-full" : activeStatus.isWarning ? " is-warning" : ""}`}>
            <UsersRound size={17} />
            <span>
              {activeTests}/{activeStatus.maxActiveTests} testing now
            </span>
          </div>
          <button className="server-pill guide-pill" type="button" aria-haspopup="dialog" aria-expanded={speedGuideOpen} aria-label="Open speed-test guide" onClick={() => setSpeedGuideOpen(true)}>
            <CircleHelp size={17} />
            <span>Speed Guide</span>
          </button>
          <button className="server-pill version-pill" type="button" aria-label={`App version v${__APP_VERSION__}`} onClick={handleAdminEntryClick}>
            <Server size={17} />
            <span>v{__APP_VERSION__}</span>
          </button>
        </div>
      </header>

      <div className="dashboard-shell">
        <div className="notice-stack">
          <WarningCarousel notices={warningNotices} activeIndex={activeNoticeIndex} onSelect={setActiveNoticeIndex} />
        </div>

        <div className="dashboard-stack">
          <section className="test-panel" aria-live="polite">
            <div className="test-panel-main">
              <div className={`speed-test-display phase-${phase}${phase === "complete" ? ` summary-${completionSummary.verdict}` : ""}`}>
                {phase === "complete" ? (
                  <CompletionSummaryPanel summary={completionSummary} testProfile={result.testProfile} />
                ) : (
                  <>
                    <div className="speed-readout">
                      <span className="speed-label">{phase === "upload" ? "Upload" : "Download"}</span>
                      <div className="speed-number">{mainDisplayValue}</div>
                      <div className="speed-unit">Mbps</div>
                    </div>
                    <div className={`speed-process-chart tone-${mainReadoutTone}`}>
                      <MetricSparkline values={mainReadoutSeries} variant="large" />
                    </div>
                    <div className="test-progress" role="progressbar" aria-label="Phase progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={roundedProgress}>
                      <div className="test-progress-track">
                        <span className="test-progress-fill" style={{ width: `${progressPercent}%` }} />
                      </div>
                      <span className="test-progress-value">{roundedProgress}%</span>
                    </div>
                  </>
                )}
              </div>

              <div className="stage-copy">
                <div>
                  <span className="stage-kicker">Current status</span>
                  {error ? (
                    <p className="error-text">{error}</p>
                  ) : (
                    <p className="stage-meta">
                      {testBlocked
                        ? "Use another device to run a valid intranet test"
                        : concurrencyFull
                          ? "Wait for an active test slot to become available"
                          : needsNetworkLinkType
                            ? "Select Wired or Wi-Fi before starting"
                            : phaseText(phase, result, completionSummary)}
                    </p>
                  )}
                  <ConnectionContextPanel state={connectionContext} />
                </div>
                <NetworkLinkSelector selected={selectedNetworkLinkType} disabled={isRunning || testBlocked || concurrencyFull} onSelect={setSelectedNetworkLinkType} />
                <TestDurationSelector selected={selectedTestDurationSeconds} disabled={isRunning} onSelect={setSelectedTestDurationSeconds} />
                <TransferSummary downloadMegabits={transferMegabits.download} uploadMegabits={transferMegabits.upload} />
                <button className="primary-action" type="button" disabled={!config || isRunning || testBlocked || concurrencyFull || !selectedNetworkLinkType} onClick={() => void startTest()}>
                  {isRunning ? <Loader2 className="spin" size={20} /> : <RotateCw size={20} />}
                  <span>{testBlocked ? "Blocked" : concurrencyFull ? "Full" : isRunning ? "Running" : buttonLabel}</span>
                </button>

                {phase === "complete" && lastSavedResult ? (
                  <ReportActions
                    busyFormat={reportBusyFormat}
                    error={reportError}
                    rawDataAvailable={rawData !== null}
                    onDownload={(format) => void downloadCurrentReport(format)}
                    onOpenRawData={() => setRawDataOpen(true)}
                  />
                ) : null}

                <div className="primary-metrics" aria-label="Speed metrics">
                  {primaryMetrics.map((metric) => (
                    <MetricCard metric={metric} variant="primary" key={metric.label} onOpen={() => setSelectedMetricLabel(metric.label)} />
                  ))}
                </div>
              </div>
            </div>

            <div className="secondary-metrics" aria-label="Quality metrics">
              {secondaryMetrics.map((metric) => (
                <MetricCard metric={metric} variant="secondary" key={metric.label} onOpen={() => setSelectedMetricLabel(metric.label)} />
              ))}
            </div>
          </section>

          <section className="history-panel" aria-label="Recent results">
            <div className="section-heading">
              <h2>Your Recent Results</h2>
              <div className="history-actions">
                <span>{recent.length} records</span>
                <button
                  aria-label="Delete all your recent results from this browser"
                  className="history-delete-button"
                  disabled={recent.length === 0 || isDeletingRecent}
                  onClick={() => void clearPersonalHistory()}
                  title="Delete all your recent results from this browser"
                  type="button"
                >
                  {isDeletingRecent ? <Loader2 className="spin" size={17} /> : <Trash2 size={17} />}
                </button>
              </div>
            </div>
            <HistoryBars results={recent} onOpen={setSelectedHistoryResult} />
          </section>
        </div>
      </div>

      {selectedMetric ? <MetricDetailModal metric={selectedMetric} onClose={() => setSelectedMetricLabel(null)} /> : null}
      {selectedHistoryResult ? <HistoryDetailModal result={selectedHistoryResult} onClose={() => setSelectedHistoryResult(null)} /> : null}
      {rawDataOpen && lastSavedResult && rawData ? <RawDataModal result={lastSavedResult} rawData={rawData} onClose={() => setRawDataOpen(false)} /> : null}
      {speedGuideOpen ? <SpeedGuideModal onClose={() => setSpeedGuideOpen(false)} /> : null}
    </main>
  );

  function stopAdminEntryResetTimer() {
    if (adminEntryResetTimerRef.current !== null) {
      window.clearTimeout(adminEntryResetTimerRef.current);
      adminEntryResetTimerRef.current = null;
    }
  }

  async function clearPersonalHistory() {
    if (recent.length === 0 || isDeletingRecent) {
      return;
    }
    if (!window.confirm("Delete all your recent results from this browser?")) {
      return;
    }

    setIsDeletingRecent(true);
    speedTest.setError(null);
    try {
      await deleteRecentResults();
      setRecent([]);
    } catch (deleteError) {
      speedTest.setError(deleteError instanceof Error ? deleteError.message : "Failed to delete recent results");
      speedTest.setPhase("error");
    } finally {
      setIsDeletingRecent(false);
    }
  }

  async function downloadCurrentReport(format: ReportFormat) {
    if (!config || !lastSavedResult || reportBusyFormat) {
      return;
    }

    setReportBusyFormat(format);
    setReportError(null);
    let context = null;
    let contextError: string | null = null;

    try {
      context = await loadReportContext();
    } catch (loadError) {
      contextError = loadError instanceof Error ? loadError.message : "Report context is unavailable";
    }

    try {
      const snapshot = buildReportSnapshot({
        savedResult: lastSavedResult,
        config,
        summary: completionSummary,
        activeStatus,
        transferMegabits,
        metricSeries,
        context,
        contextError,
        appVersion: __APP_VERSION__,
        pageUrl: window.location.href
      });
      await downloadReport(snapshot, format);
    } catch (downloadError) {
      setReportError(downloadError instanceof Error ? downloadError.message : "Failed to create report");
    } finally {
      setReportBusyFormat(null);
    }
  }
}

function TransferSummary({ downloadMegabits, uploadMegabits }: { downloadMegabits: number; uploadMegabits: number }) {
  return (
    <div className="transfer-summary" aria-label="Current test accumulated transfer">
      <div className="transfer-summary-item">
        <span>Total Download</span>
        <strong>
          {formatNumber(downloadMegabits)} <em>Mb</em>
        </strong>
      </div>
      <div className="transfer-summary-item">
        <span>Total Upload</span>
        <strong>
          {formatNumber(uploadMegabits)} <em>Mb</em>
        </strong>
      </div>
    </div>
  );
}

function CompletionSummaryPanel({ summary, testProfile }: { summary: CompletionSummary; testProfile: ResultPayload["testProfile"] }) {
  return (
    <div className="completion-summary" aria-label="Test summary">
      <div>
        <span className="completion-summary-kicker">Test Summary</span>
        <strong className="completion-summary-title">{summary.title}</strong>
        <p className="completion-summary-subtitle">{summary.subtitle}</p>
        <div className="completion-badges">
          <span className="completion-link-type">Link: {summary.networkLinkTypeLabel}</span>
          {testProfile === "local-throttled" ? <span className="completion-profile">Local throttled</span> : null}
        </div>
      </div>
      <div className="completion-summary-grid">
        {summary.tiles.map((tile) => (
          <div className={`completion-summary-tile grade-${tile.grade}`} key={tile.label}>
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
            <em>{tile.detail}</em>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionContextPanel({ state }: { state: ConnectionContextState }) {
  if (state.status === "ready" && state.context) {
    return (
      <div className="connection-summary" aria-label="Current connection IP">
        <div className="connection-summary-item">
          <span>Client IP</span>
          <strong>{state.context.clientIp}</strong>
        </div>
        <div className="connection-summary-item">
          <span>Source</span>
          <strong>{connectionSourceLabel(state.context)}</strong>
        </div>
      </div>
    );
  }

  return (
    <div className={`connection-summary connection-summary-${state.status}`} aria-label="Current connection IP">
      <div className="connection-summary-message">
        <span>Client IP</span>
        <strong>{state.status === "loading" ? "Checking connection" : "Connection unavailable"}</strong>
      </div>
    </div>
  );
}

function connectionSourceLabel(context: ReportContextResponse): string {
  return context.ipSource === "trusted-proxy-request-ip" ? "Trusted proxy" : "Direct";
}

function NetworkLinkSelector({
  selected,
  disabled,
  onSelect
}: {
  selected: SelectableNetworkLinkType | null;
  disabled: boolean;
  onSelect: (type: SelectableNetworkLinkType) => void;
}) {
  return (
    <div className="link-type-selector" aria-label="Network link type">
      <NetworkLinkButton type="wired" selected={selected === "wired"} disabled={disabled} onSelect={onSelect} />
      <NetworkLinkButton type="wifi" selected={selected === "wifi"} disabled={disabled} onSelect={onSelect} />
    </div>
  );
}

function NetworkLinkButton({
  type,
  selected,
  disabled,
  onSelect
}: {
  type: SelectableNetworkLinkType;
  selected: boolean;
  disabled: boolean;
  onSelect: (type: SelectableNetworkLinkType) => void;
}) {
  const Icon = type === "wired" ? Cable : Wifi;
  const label = networkLinkTypeLabel(type);
  return (
    <button className={`link-type-button${selected ? " is-selected" : ""}`} type="button" aria-pressed={selected} disabled={disabled} onClick={() => onSelect(type)}>
      <Icon size={17} strokeWidth={2.3} />
      <span>{label}</span>
    </button>
  );
}

function TestDurationSelector({
  selected,
  disabled,
  onSelect
}: {
  selected: TestDurationSeconds;
  disabled: boolean;
  onSelect: (duration: TestDurationSeconds) => void;
}) {
  return (
    <div className="test-duration-selector" aria-label="Test duration">
      {TEST_DURATIONS.map((duration) => (
        <button className={`test-duration-button${selected === duration ? " is-selected" : ""}`} type="button" aria-pressed={selected === duration} disabled={disabled} key={duration} onClick={() => onSelect(duration)}>
          <Clock3 size={15} strokeWidth={2.3} />
          <span>{duration === 20 ? "Quick" : "Full"}</span>
          <strong>{duration}s</strong>
        </button>
      ))}
    </div>
  );
}

function ReportActions({
  busyFormat,
  error,
  rawDataAvailable,
  onDownload,
  onOpenRawData
}: {
  busyFormat: ReportFormat | null;
  error: string | null;
  rawDataAvailable: boolean;
  onDownload: (format: ReportFormat) => void;
  onOpenRawData: () => void;
}) {
  return (
    <div className="report-actions" aria-label="Completed test actions">
      <div className="report-actions-row">
        <button className="report-action-button" type="button" disabled={busyFormat !== null} onClick={() => onDownload("html")}>
          {busyFormat === "html" ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
          <span>HTML</span>
        </button>
        <button className="report-action-button" type="button" disabled={busyFormat !== null} onClick={() => onDownload("png")}>
          {busyFormat === "png" ? <Loader2 className="spin" size={16} /> : <Image size={16} />}
          <span>PNG</span>
        </button>
        <button className="report-action-button" type="button" disabled={busyFormat !== null} onClick={() => onDownload("markdown")}>
          {busyFormat === "markdown" ? <Loader2 className="spin" size={16} /> : <FileText size={16} />}
          <span>Markdown</span>
        </button>
        <button className="report-action-button" type="button" disabled={!rawDataAvailable || busyFormat !== null} onClick={onOpenRawData}>
          <Database size={16} />
          <span>Raw Data</span>
        </button>
      </div>
      {error ? <p className="report-error" role="status">{error}</p> : null}
    </div>
  );
}

function WarningCarousel({ notices, activeIndex, onSelect }: { notices: WarningNotice[]; activeIndex: number; onSelect: (index: number) => void }) {
  const noticeCardRef = useRef<HTMLElement | null>(null);
  const messageFrameRef = useRef<HTMLParagraphElement | null>(null);
  const messageTextRef = useRef<HTMLSpanElement | null>(null);
  const [isPaused, setIsPaused] = useState(false);
  const [marqueeDistance, setMarqueeDistance] = useState(0);

  const currentIndex = Math.min(activeIndex, notices.length - 1);
  const notice = notices[currentIndex];
  const hasMultiple = notices.length > 1;
  const countLabel = `${currentIndex + 1}/${notices.length}`;
  const marqueeStyle = {
    "--notice-marquee-distance": `${marqueeDistance}px`,
    "--notice-marquee-duration": `${Math.max(6, Math.round(marqueeDistance / 20))}s`
  } as React.CSSProperties;

  function selectPrevious() {
    onSelect((currentIndex + notices.length - 1) % notices.length);
  }

  function selectNext() {
    onSelect((currentIndex + 1) % notices.length);
  }

  useEffect(() => {
    if (!hasMultiple || isPaused) {
      return;
    }

    const timer = window.setInterval(() => {
      if (noticeCardRef.current?.matches(":hover, :focus-within")) {
        return;
      }
      onSelect((currentIndex + 1) % notices.length);
    }, 2000);
    return () => window.clearInterval(timer);
  }, [currentIndex, hasMultiple, isPaused, notices.length, onSelect]);

  useEffect(() => {
    const frame = messageFrameRef.current;
    const text = messageTextRef.current;
    if (!frame || !text) {
      setMarqueeDistance(0);
      return;
    }
    const frameElement = frame;
    const textElement = text;

    function updateMarqueeDistance() {
      setMarqueeDistance(Math.max(0, Math.ceil(textElement.scrollWidth - frameElement.clientWidth + 18)));
    }

    updateMarqueeDistance();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateMarqueeDistance);
      return () => window.removeEventListener("resize", updateMarqueeDistance);
    }

    const observer = new ResizeObserver(updateMarqueeDistance);
    observer.observe(frameElement);
    observer.observe(textElement);
    return () => observer.disconnect();
  }, [notice.message]);

  if (notices.length === 0) {
    return null;
  }

  return (
    <section
      ref={noticeCardRef}
      className={`notice-card notice-card-${notice.kind}${notice.isFull ? " is-full" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={`${notice.title}, ${countLabel}`}
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onFocus={() => setIsPaused(true)}
      onBlur={() => setIsPaused(false)}
    >
      <notice.icon size={20} />
      <div className="notice-content">
        <div className="notice-title-row">
          <strong>{notice.title}</strong>
          {notice.badge ? <span className="local-throttle-badge">{notice.badge}</span> : null}
        </div>
        <p ref={messageFrameRef} className={`notice-message${marqueeDistance > 0 ? " is-marquee" : ""}`} style={marqueeStyle}>
          <span ref={messageTextRef} className="notice-message-text">
            {notice.message}
          </span>
        </p>
      </div>
      <div className="notice-carousel-controls" aria-label="Warning carousel">
        {hasMultiple ? (
          <button className="notice-step-button" type="button" aria-label="Previous warning" onClick={selectPrevious}>
            <ChevronLeft size={16} strokeWidth={2.4} />
          </button>
        ) : null}
        <span className="notice-index" aria-label={`Warning ${countLabel}`}>
          {countLabel}
        </span>
        {hasMultiple ? (
          <button className="notice-step-button" type="button" aria-label="Next warning" onClick={selectNext}>
            <ChevronRight size={16} strokeWidth={2.4} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

function MetricCard({ metric, variant, onOpen }: { metric: Metric; variant: "primary" | "secondary"; onOpen: () => void }) {
  return (
    <button className={`metric-card metric-card-${variant} tone-${metric.tone}`} type="button" aria-label={`Open ${metric.label} details`} onClick={onOpen}>
      <div className="metric-card-head">
        <metric.icon size={20} strokeWidth={2.2} />
        <span className="metric-label">{metric.label}</span>
      </div>
      <div className="metric-card-value">
        <strong>{metric.value}</strong>
        <span className="metric-unit">{metric.unit}</span>
      </div>
      {metric.stats ? <MetricStatsStrip stats={metric.stats} /> : null}
      <MetricSparkline values={metric.series} />
    </button>
  );
}

function MetricDetailModal({ metric, onClose }: { metric: Metric; onClose: () => void }) {
  return (
    <div className="metric-modal-backdrop" onMouseDown={onClose}>
      <section className={`metric-modal tone-${metric.tone}`} role="dialog" aria-modal="true" aria-label={`${metric.label} details`} onMouseDown={(event) => event.stopPropagation()}>
        <div className="metric-modal-header">
          <div className="metric-modal-title">
            <metric.icon size={22} strokeWidth={2.2} />
            <div>
              <span>{metric.label}</span>
              <strong>
                {metric.value} <em>{metric.unit}</em>
              </strong>
            </div>
          </div>
          <button className="metric-modal-close" type="button" aria-label="Close details" onClick={onClose}>
            <X size={20} strokeWidth={2.2} />
          </button>
        </div>
        {metric.stats ? <MetricStatsPanel stats={metric.stats} /> : null}
        <InteractiveMetricChart metric={metric} />
      </section>
    </div>
  );
}

function SpeedGuideModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="metric-modal-backdrop" onMouseDown={onClose}>
      <section className="metric-modal speed-guide-modal" role="dialog" aria-modal="true" aria-label="Speed-test guide" onMouseDown={(event) => event.stopPropagation()}>
        <div className="metric-modal-header">
          <div className="metric-modal-title">
            <CircleHelp size={22} strokeWidth={2.2} />
            <div>
              <span>Speed Guide</span>
              <strong>How results are measured and judged</strong>
              <em>Reference notes and IT diagnostic thresholds</em>
            </div>
          </div>
          <button className="metric-modal-close" type="button" aria-label="Close speed-test guide" onClick={onClose}>
            <X size={20} strokeWidth={2.2} />
          </button>
        </div>

        <div className="speed-guide-content">
          <section className="speed-guide-section">
            <h2>How Values Are Collected</h2>
            <p>
              The test runs in a browser Web Worker. Quick 20s and Full 30s send download, upload, and latency requests to the same intranet service. Each throughput sample converts the bytes observed in its time window into Mbps.
            </p>
            <p>
              The first segment, up to 1 second, is warmup and is excluded from throughput statistics. After warmup, the first roughly 3% of startup samples are trimmed. The main Download and Upload values use the IQR-filtered stable mean so short spikes or drops do not dominate the headline speed.
            </p>
          </section>

          <section className="speed-guide-section">
            <h2>How To Read The Metrics</h2>
            <div className="speed-guide-grid">
              <GuideTile label="P10 Low" value="Low-speed experience" detail="If it is far below stable mean, users may feel stalls or drops." />
              <GuideTile label="P50 Typical" value="Typical value" detail="The median value, showing where most samples sit." />
              <GuideTile label="P75 / Q3, P90" value="Upper range" detail="Shows stronger throughput periods, but not stability by itself." />
              <GuideTile label="Raw CV" value="Raw variability" detail="Relative variation before IQR filtering; keeps spike and drop signals." />
              <GuideTile label="Stable CV" value="Stable variability" detail="Relative variation after IQR filtering; shows whether stable mean is concentrated." />
              <GuideTile label="IQR kept" value="Sample confidence" detail="A lower kept ratio means more outliers and a more diagnostic result." />
            </div>
          </section>

          <section className="speed-guide-section">
            <h2>Quality Thresholds</h2>
            <div className="speed-guide-tables">
              <GuideThresholdTable
                title="Reliability / HTTP Loss"
                rows={[
                  ["Excellent", "0%"],
                  ["Good", "<= 0.5%"],
                  ["Fair", "<= 2%"],
                  ["Poor", "> 2%"]
                ]}
              />
              <GuideThresholdTable
                title="Responsiveness / Loaded latency"
                rows={[
                  ["Excellent", "<= 50 ms"],
                  ["Good", "<= 100 ms"],
                  ["Fair", "<= 200 ms"],
                  ["Poor", "> 200 ms"]
                ]}
              />
            </div>
          </section>

          <section className="speed-guide-section">
            <h2>Stability Thresholds</h2>
            <div className="speed-guide-compare">
              <div>
                <h3>Wired / Unknown</h3>
                <ul>
                  <li>Raw CV: 10 / 20 / 35%</li>
                  <li>P10 / Mean: 85 / 70 / 50%</li>
                  <li>IQR outlier: 2 / 5 / 10%</li>
                  <li>Jitter: 5 / 15 / 30 ms</li>
                </ul>
              </div>
              <div>
                <h3>Wi-Fi</h3>
                <ul>
                  <li>Raw CV: 15 / 30 / 45%</li>
                  <li>P10 ratio or P10: 85 / 70 / 50%, or 500 / 300 / 150 Mbps</li>
                  <li>IQR outlier: 5 / 10 / 20%</li>
                  <li>Jitter: 8 / 20 / 40 ms</li>
                </ul>
              </div>
            </div>
            <p>
              Wired results use stricter worst-grade judging. Wi-Fi is a shared medium, so a connection can be variable but still usable when throughput remains practical. To isolate wireless environment, device, or signal issues, retest on Wired.
            </p>
          </section>

          <section className="speed-guide-section speed-guide-note">
            <h2>Limits</h2>
            <p>
              Local throttled results are maintenance checks only, not real intranet path measurements. Wi-Fi results include signal quality, interference, client hardware, and power-saving behavior. Interpret results together with link type, duration, sample count, and Raw Data.
            </p>
          </section>
        </div>
      </section>
    </div>
  );
}

function GuideTile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="speed-guide-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </div>
  );
}

function GuideThresholdTable({ title, rows }: { title: string; rows: Array<[string, string]> }) {
  return (
    <div className="speed-guide-table-block">
      <h3>{title}</h3>
      <table className="speed-guide-threshold-table">
        <tbody>
          {rows.map(([grade, threshold]) => (
            <tr key={grade}>
              <th scope="row">{grade}</th>
              <td>{threshold}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistoryDetailModal({ result, onClose }: { result: SavedResult; onClose: () => void }) {
  return (
    <div className="metric-modal-backdrop" onMouseDown={onClose}>
      <section className="metric-modal history-detail-modal" role="dialog" aria-modal="true" aria-label="Recent result details" onMouseDown={(event) => event.stopPropagation()}>
        <div className="metric-modal-header">
          <div className="metric-modal-title">
            <Clock3 size={22} strokeWidth={2.2} />
            <div>
              <span>Recent Result</span>
              <strong>{formatDateTime(result.createdAt)}</strong>
              {result.isLocalClient ? <em>Local self-test</em> : null}
              {result.testProfile === "local-throttled" ? <em>Local throttled</em> : null}
            </div>
          </div>
          <button className="metric-modal-close" type="button" aria-label="Close recent result details" onClick={onClose}>
            <X size={20} strokeWidth={2.2} />
          </button>
        </div>

        <div className="history-detail-grid">
          <HistoryDetailTile label="Download" value={formatNumber(result.downloadMbps)} unit="Mbps" />
          <HistoryDetailTile label="Upload" value={formatNumber(result.uploadMbps)} unit="Mbps" />
          <HistoryDetailTile label="Link" value={networkLinkTypeLabel(result.networkLinkType)} />
          <HistoryDetailTile label="Client IP" value={resultClientIpText(result)} />
          <HistoryDetailTile label="Server" value={result.serverName} />
          <HistoryDetailTile label="Idle Latency" value={formatNumber(result.idleLatencyMs)} unit="ms" />
          <HistoryDetailTile label="Download Loaded" value={formatNumber(result.downloadLoadedLatencyMs)} unit="ms" />
          <HistoryDetailTile label="Upload Loaded" value={formatNumber(result.uploadLoadedLatencyMs)} unit="ms" />
          <HistoryDetailTile label="Jitter" value={formatNumber(result.jitterMs)} unit="ms" />
          <HistoryDetailTile label="HTTP Loss" value={formatNumber(result.httpLossPercent)} unit="%" />
          <HistoryDetailTile label="Duration" value={String(result.durationSeconds)} unit="sec" />
          <HistoryDetailTile label="Connections" value={String(result.parallelConnections)} />
          <HistoryDetailTile label="Profile" value={testProfileLabel(result.testProfile)} />
          <HistoryDetailTile label="Browser" value={result.browserFamily} />
        </div>

        <div className="history-detail-stats">
          <HistoryStatsPanel title="Download Distribution" stats={result.downloadStats} />
          <HistoryStatsPanel title="Upload Distribution" stats={result.uploadStats} />
        </div>
      </section>
    </div>
  );
}

function RawDataModal({ result, rawData, onClose }: { result: SavedResult; rawData: RawTestData; onClose: () => void }) {
  const rows = useMemo(() => buildRawDataRows(rawData, result), [rawData, result]);
  const groups = useMemo(() => ["All", ...Array.from(new Set(rows.map((row) => row.group)))], [rows]);
  const [selectedGroup, setSelectedGroup] = useState("All");
  const visibleRows = selectedGroup === "All" ? rows : rows.filter((row) => row.group === selectedGroup);
  const summary = useMemo(() => summarizeRawDataRows(rows), [rows]);

  return (
    <div className="metric-modal-backdrop" onMouseDown={onClose}>
      <section className="metric-modal raw-data-modal" role="dialog" aria-modal="true" aria-label="Raw test data" onMouseDown={(event) => event.stopPropagation()}>
        <div className="metric-modal-header">
          <div className="metric-modal-title">
            <Database size={22} strokeWidth={2.2} />
            <div>
              <span>Raw Test Data</span>
              <strong>{formatDateTime(result.createdAt)}</strong>
              <em>{summary.used}/{summary.total} samples used</em>
            </div>
          </div>
          <div className="raw-data-header-actions">
            <button className="report-action-button raw-data-download" type="button" onClick={() => downloadRawDataCsv(rows, result.createdAt)}>
              <ArrowDown size={16} />
              <span>CSV</span>
            </button>
            <button className="metric-modal-close" type="button" aria-label="Close raw data" onClick={onClose}>
              <X size={20} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div className="raw-data-summary" aria-label="Raw data usage summary">
          <RawDataSummaryTile label="Total samples" value={summary.total} />
          <RawDataSummaryTile label="Used" value={summary.used} />
          <RawDataSummaryTile label="Excluded or failed" value={summary.excluded} />
        </div>

        <div className="raw-data-tabs" aria-label="Raw data groups">
          {groups.map((group) => (
            <button className={`raw-data-tab${selectedGroup === group ? " is-selected" : ""}`} type="button" aria-pressed={selectedGroup === group} key={group} onClick={() => setSelectedGroup(group)}>
              {group}
            </button>
          ))}
        </div>

        <div className="raw-data-table-shell">
          <table className="raw-data-table">
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Sample</th>
                <th scope="col">Value</th>
                <th scope="col">Status</th>
                <th scope="col">Used in</th>
                <th scope="col">Excluded from</th>
                <th scope="col">Transfer</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <RawDataTableRow row={row} key={`${row.group}-${row.sample_index}`} />
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function RawDataSummaryTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="raw-data-summary-tile">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RawDataTableRow({ row }: { row: RawDataRow }) {
  const transfer = row.bytes ? `${row.bytes} bytes / ${row.elapsed_ms} ms` : "n/a";
  return (
    <tr>
      <td>{row.group}</td>
      <td>{row.sample_index}</td>
      <td>
        <strong>{row.value || "Failed"}</strong> <span>{row.unit}</span>
      </td>
      <td>
        <span className={`raw-data-status raw-data-status-${row.status}`}>{rawDataStatusLabel(row.status)}</span>
        <em>{row.reason}</em>
      </td>
      <td>{row.used_in || "n/a"}</td>
      <td>{row.excluded_from || "n/a"}</td>
      <td>{transfer}</td>
    </tr>
  );
}

function HistoryDetailTile({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="history-detail-tile">
      <span>{label}</span>
      <strong>{value}</strong>
      {unit ? <em>{unit}</em> : null}
    </div>
  );
}

function rawDataStatusLabel(status: string): string {
  if (status === "startup-excluded") return "Startup excluded";
  if (status === "iqr-excluded") return "IQR excluded";
  if (status === "failed") return "Failed";
  return "Used";
}

function HistoryStatsPanel({ title, stats }: { title: string; stats: ThroughputStats }) {
  return (
    <section className="history-detail-stat-panel" aria-label={title}>
      <h3>{title}</h3>
      <MetricStatsPanel stats={stats} />
    </section>
  );
}

function InteractiveMetricChart({ metric }: { metric: Metric }) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const values = metric.series.filter(Number.isFinite);
  const width = 100;
  const height = 52;
  const paddingX = 4;
  const paddingY = 7;

  if (values.length < 2) {
    return (
      <div className="metric-detail-chart-shell">
        <svg className="metric-detail-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
          <line className="metric-sparkline-grid" x1="0" y1="17" x2={width} y2="17" />
          <line className="metric-sparkline-grid" x1="0" y1="35" x2={width} y2="35" />
          <line className="metric-sparkline-baseline" x1={paddingX} y1="26" x2={width - paddingX} y2="26" />
        </svg>
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const points = values.map((value, index) => sparklinePoint(value, index, values.length, min, range, width, height, paddingX, paddingY));
  const pointsValue = points.map(([x, y]) => `${x},${y}`).join(" ");
  const activeIndex = hoveredIndex === null ? null : Math.min(values.length - 1, Math.max(0, hoveredIndex));
  const activePoint = activeIndex === null ? null : points[activeIndex];
  const activeValue = activeIndex === null ? null : values[activeIndex];

  function updateHover(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = clampNumber((event.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
    setHoveredIndex(Math.round(ratio * (values.length - 1)));
  }

  return (
    <div className="metric-detail-chart-shell">
      <svg
        className="metric-detail-chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
        onPointerLeave={() => setHoveredIndex(null)}
        onPointerMove={updateHover}
      >
        <line className="metric-sparkline-grid" x1="0" y1="17" x2={width} y2="17" />
        <line className="metric-sparkline-grid" x1="0" y1="35" x2={width} y2="35" />
        <polyline className="metric-sparkline-line metric-detail-chart-line" points={pointsValue} />
        {activePoint ? (
          <>
            <line className="metric-detail-guide" x1={activePoint[0]} y1={paddingY} x2={activePoint[0]} y2={height - paddingY} />
            <circle className="metric-detail-marker" cx={activePoint[0]} cy={activePoint[1]} r="0.55" />
          </>
        ) : null}
      </svg>
      {activePoint && activeValue !== null ? (
        <div className="metric-detail-tooltip" style={{ left: `${(activePoint[0] / width) * 100}%`, top: `${(activePoint[1] / height) * 100}%` }}>
          <span>Sample {activeIndex === null ? 1 : activeIndex + 1}</span>
          <strong>
            {formatNumber(activeValue)} {metric.unit}
          </strong>
        </div>
      ) : null}
    </div>
  );
}

function HistoryBars({ results, onOpen }: { results: SavedResult[]; onOpen: (result: SavedResult) => void }) {
  const visible = results.slice(0, 18).reverse();
  const max = Math.max(1, ...visible.map((item) => Math.max(item.downloadMbps, item.uploadMbps)));

  if (visible.length === 0) {
    return <div className="empty-history">No personal records</div>;
  }

  return (
    <div className="history-bars">
      {visible.map((item, index) => {
        const tooltipId = `history-tooltip-${item.id}`;
        return (
          <button
            aria-describedby={tooltipId}
            aria-haspopup="dialog"
            aria-label={`Open recent result details: ${historyItemLabel(item)}`}
            className={`history-item${item.isLocalClient ? " is-local" : ""} ${historyTooltipPlacement(index, visible.length)}`}
            key={item.id}
            onClick={() => onOpen(item)}
            type="button"
          >
            <span className="download-bar" style={{ height: `${Math.max(6, (item.downloadMbps / max) * 100)}%` }} />
            <span className="upload-bar" style={{ height: `${Math.max(6, (item.uploadMbps / max) * 100)}%` }} />
            <div className="history-tooltip" id={tooltipId} role="tooltip">
              <span className="history-tooltip-time">{formatDateTime(item.createdAt)}</span>
              <div className="history-tooltip-row">
                <span>Download</span>
                <strong>{formatNumber(item.downloadMbps)} Mbps</strong>
              </div>
              <div className="history-tooltip-row">
                <span>Upload</span>
                <strong>{formatNumber(item.uploadMbps)} Mbps</strong>
              </div>
              <div className="history-tooltip-row">
                <span>Link</span>
                <strong>{networkLinkTypeLabel(item.networkLinkType)}</strong>
              </div>
              <div className="history-tooltip-row">
                <span>Client IP</span>
                <strong>{resultClientIpText(item)}</strong>
              </div>
              {item.testProfile === "local-throttled" ? (
                <div className="history-tooltip-row">
                  <span>Profile</span>
                  <strong>Local throttled</strong>
                </div>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MetricSparkline({ values, variant = "compact" }: { values: number[]; variant?: "compact" | "large" }) {
  const visible = values.filter(Number.isFinite).slice(-64);
  const width = 100;
  const height = 36;
  const paddingX = 3;
  const paddingY = 5;

  if (visible.length < 2) {
    return (
      <svg className={`metric-sparkline metric-sparkline-${variant}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
        <line className="metric-sparkline-grid" x1="0" y1="12" x2={width} y2="12" />
        <line className="metric-sparkline-grid" x1="0" y1="24" x2={width} y2="24" />
        <line className="metric-sparkline-baseline" x1={paddingX} y1="18" x2={width - paddingX} y2="18" />
      </svg>
    );
  }

  const min = Math.min(...visible);
  const max = Math.max(...visible);
  const range = max - min;
  const points = visible.map((value, index) => sparklinePoint(value, index, visible.length, min, range, width, height, paddingX, paddingY));
  const pointsValue = points.map(([x, y]) => `${x},${y}`).join(" ");

  return (
    <svg className={`metric-sparkline metric-sparkline-${variant}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <line className="metric-sparkline-grid" x1="0" y1="12" x2={width} y2="12" />
      <line className="metric-sparkline-grid" x1="0" y1="24" x2={width} y2="24" />
      <polyline className="metric-sparkline-line" points={pointsValue} />
    </svg>
  );
}

function MetricStatsStrip({ stats }: { stats: ThroughputStats }) {
  return (
    <div className="metric-stats-strip" aria-label="Throughput summary">
      <span>P10 {formatNumber(stats.p10Mbps)}</span>
      <span>P90 {formatNumber(stats.p90Mbps)}</span>
      <span>Raw CV {formatNumber(stats.rawCvPercent)}%</span>
      <span>Kept {stats.filteredSampleCount}/{stats.sampleCount}</span>
    </div>
  );
}

function MetricStatsPanel({ stats }: { stats: ThroughputStats }) {
  const iqrKept = iqrKeptDisplay(stats);

  return (
    <div className="metric-stats-panel" aria-label="Throughput percentile summary">
      <StatTile label="Stable Mean" value={stats.meanMbps} />
      <StatTile label="P10 Low" value={stats.p10Mbps} />
      <StatTile label="P50 Typical" value={stats.p50Mbps} />
      <StatTile label="P75 / Q3" value={stats.p75Mbps} />
      <StatTile label="P90 High" value={stats.p90Mbps} />
      <div className="metric-stat-tile">
        <span>Raw CV</span>
        <strong>{formatNumber(stats.rawCvPercent)}%</strong>
      </div>
      <div className="metric-stat-tile">
        <span>Stable CV</span>
        <strong>{formatNumber(stats.cvPercent)}%</strong>
      </div>
      <div className="metric-stat-tile">
        <span>IQR kept</span>
        <strong>{iqrKept.value}</strong>
        <em>{iqrKept.detail}</em>
      </div>
    </div>
  );
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric-stat-tile">
      <span>{label}</span>
      <strong>{formatNumber(value)}</strong>
      <em>Mbps</em>
    </div>
  );
}

function phaseText(phase: TestPhase, result: ResultPayload, summary: CompletionSummary): string {
  if (phase === "latency") return "Latency";
  if (phase === "download") return `${formatNumber(result.idleLatencyMs)} ms idle`;
  if (phase === "upload") return `${formatNumber(result.downloadMbps)} Mbps down`;
  if (phase === "saving") return "Saving result";
  if (phase === "complete") return summary.title;
  return "Ready";
}

function sparklinePoint(
  value: number,
  index: number,
  total: number,
  min: number,
  range: number,
  width: number,
  height: number,
  paddingX: number,
  paddingY: number
): [number, number] {
  const plotWidth = width - paddingX * 2;
  const plotHeight = height - paddingY * 2;
  const x = paddingX + (plotWidth * index) / Math.max(1, total - 1);
  const y = range === 0 ? height / 2 : paddingY + (1 - (value - min) / range) * plotHeight;

  return [roundSvg(x), roundSvg(y)];
}

function roundSvg(value: number): number {
  return Math.round(value * 100) / 100;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 100) return value.toFixed(0);
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function historyItemLabel(item: SavedResult): string {
  const localPrefix = item.isLocalClient ? "Local self-test, " : "";
  const profilePrefix = item.testProfile === "local-throttled" ? "Local throttled, " : "";
  return `${localPrefix}${profilePrefix}${formatDateTime(item.createdAt)}, ${networkLinkTypeLabel(item.networkLinkType)} link, Client IP ${resultClientIpText(item)}, Download ${formatNumber(item.downloadMbps)} Mbps, Upload ${formatNumber(item.uploadMbps)} Mbps`;
}

function historyTooltipPlacement(index: number, total: number): string {
  if (index <= 1) return "tooltip-left";
  if (index >= total - 2) return "tooltip-right";
  return "tooltip-center";
}

function resultClientIpText(result: SavedResult): string {
  return result.clientIp ?? "Not recorded";
}

function testProfileLabel(profile: ResultPayload["testProfile"]): string {
  return profile === "local-throttled" ? "Local throttled" : "Standard";
}
