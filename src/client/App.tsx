import {
  Activity,
  ArrowDown,
  ArrowUp,
  Clock3,
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
import { useEffect, useMemo, useRef, useState } from "react";

import {
  type ActiveTestsResponse,
  type ResultPayload,
  type RuntimeConfigResponse,
  type SavedResult,
  type ThroughputStats
} from "../shared/contracts";
import {
  createEmptyMetricSeries,
  deleteRecentResults,
  finishActiveTestSession,
  heartbeatActiveTestSession,
  loadActiveTests,
  loadRecentResults,
  loadRuntimeConfig,
  saveResult,
  startActiveTestSession,
  type MetricSeries,
  type TestPhase,
  type TestProgress
} from "./speed-test";
import { AdminConsole } from "./AdminConsole";
import { buildCompletionSummary, type CompletionSummary } from "./result-summary";
import { isSpeedTestWorkerAbort, startSpeedTestWorker, type RunningSpeedTestWorker } from "./speed-test-worker-client";

type MetricTone = "teal" | "amber" | "blue" | "rose" | "ink" | "green";

type Metric = {
  label: string;
  value: string;
  unit: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  tone: MetricTone;
  series: number[];
  stats?: ThroughputStats;
};

type TransferMegabits = {
  download: number;
  upload: number;
};

declare const __APP_VERSION__: string;

const emptyResult: ResultPayload = {
  downloadMbps: 0,
  uploadMbps: 0,
  downloadStats: emptyThroughputStats(),
  uploadStats: emptyThroughputStats(),
  idleLatencyMs: 0,
  downloadLoadedLatencyMs: 0,
  uploadLoadedLatencyMs: 0,
  jitterMs: 0,
  httpLossPercent: 0,
  durationSeconds: 0,
  parallelConnections: 0
};

const emptyActiveStatus: ActiveTestsResponse = {
  activeTests: 0,
  warningThreshold: 2,
  maxActiveTests: 4,
  isWarning: false,
  isFull: false,
  updatedAt: ""
};

export function App() {
  return window.location.pathname === "/admin" ? <AdminConsole /> : <SpeedTestApp />;
}

function SpeedTestApp() {
  const [config, setConfig] = useState<RuntimeConfigResponse | null>(null);
  const [recent, setRecent] = useState<SavedResult[]>([]);
  const [result, setResult] = useState<ResultPayload>(emptyResult);
  const [phase, setPhase] = useState<TestPhase>("idle");
  const [currentMbps, setCurrentMbps] = useState<number | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [metricSeries, setMetricSeries] = useState<MetricSeries>(() => createEmptyMetricSeries());
  const [transferMegabits, setTransferMegabits] = useState<TransferMegabits>({ download: 0, upload: 0 });
  const [activeStatus, setActiveStatus] = useState<ActiveTestsResponse>(emptyActiveStatus);
  const [error, setError] = useState<string | null>(null);
  const [selectedMetricLabel, setSelectedMetricLabel] = useState<string | null>(null);
  const [isDeletingRecent, setIsDeletingRecent] = useState(false);
  const activeSessionRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);
  const workerRunRef = useRef<RunningSpeedTestWorker | null>(null);
  const testRunIdRef = useRef(0);

  const isRunning = ["latency", "download", "upload", "saving"].includes(phase);
  const isSpeedPhase = phase === "download" || phase === "upload";
  const mainDisplayValue = isSpeedPhase && currentMbps === null ? "--" : formatNumber(isSpeedPhase && currentMbps !== null ? currentMbps : result.downloadMbps);
  const roundedProgress = Math.round(progressPercent);
  const localClientWarning = config?.clientSafety.isLocalClient ? config.clientSafety.message : null;
  const testBlocked = config ? !config.clientSafety.canRunTest : false;
  const activeTests = activeStatus.activeTests;
  const concurrencyFull = !testBlocked && activeStatus.isFull;
  const concurrencyWarning = !testBlocked && activeStatus.isWarning;
  const mainReadoutTone: MetricTone = phase === "upload" ? "amber" : "teal";
  const mainReadoutSeries = phase === "upload" ? metricSeries.uploadMbps : metricSeries.downloadMbps;
  const completionSummary = useMemo(() => buildCompletionSummary(result, config?.catSpeedRanges), [config?.catSpeedRanges, result]);

  useEffect(() => {
    void Promise.all([loadRuntimeConfig(), loadRecentResults(), loadActiveTests()])
      .then(([runtimeConfig, recentResults, activeTestsResult]) => {
        setConfig(runtimeConfig);
        setRecent(recentResults);
        setActiveStatus(activeTestsResult);
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "Failed to load");
        setProgressPercent(0);
        setPhase("error");
      });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshActiveTests();
    }, 5000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      terminateCurrentWorkerRun();
      stopHeartbeat();
      if (activeSessionRef.current) {
        void finishActiveTestSession(activeSessionRef.current).catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!selectedMetricLabel) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSelectedMetricLabel(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedMetricLabel]);

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
    if (!config || isRunning || testBlocked || concurrencyFull) return;

    terminateCurrentWorkerRun();
    const runId = testRunIdRef.current + 1;
    testRunIdRef.current = runId;
    setError(null);
    let sessionId: string | null = null;
    let workerRun: RunningSpeedTestWorker | null = null;
    let latestTransferMegabits: TransferMegabits = { download: 0, upload: 0 };
    try {
      const runtimeConfig = await loadRuntimeConfig();
      setConfig(runtimeConfig);
      if (!runtimeConfig.clientSafety.canRunTest) {
        setError(runtimeConfig.clientSafety.message ?? "This client is blocked from running speed tests.");
        setPhase("error");
        return;
      }

      setResult({
        ...emptyResult,
        durationSeconds: runtimeConfig.defaultTestDurationSeconds,
        parallelConnections: runtimeConfig.parallelConnections
      });
      setCurrentMbps(null);
      setProgressPercent(0);
      setMetricSeries(createEmptyMetricSeries());
      setTransferMegabits({ download: 0, upload: 0 });

      const session = await startActiveTestSession();
      sessionId = session.sessionId;
      activeSessionRef.current = sessionId;
      setActiveStatus(session);
      startHeartbeat(sessionId);

      workerRun = startSpeedTestWorker(runtimeConfig, (progress: TestProgress) => {
        if (testRunIdRef.current !== runId) {
          return;
        }

        setPhase(progress.phase);
        if (progress.currentMbps !== undefined) {
          setCurrentMbps(progress.currentMbps);
        }
        if (typeof progress.progressPercent === "number") {
          setProgressPercent(progress.progressPercent);
        }
        if (typeof progress.downloadMegabits === "number" || typeof progress.uploadMegabits === "number") {
          latestTransferMegabits = {
            download: typeof progress.downloadMegabits === "number" ? progress.downloadMegabits : latestTransferMegabits.download,
            upload: typeof progress.uploadMegabits === "number" ? progress.uploadMegabits : latestTransferMegabits.upload
          };
          setTransferMegabits(latestTransferMegabits);
        }
        if (progress.partial) {
          setResult((previous) => ({ ...previous, ...progress.partial }));
        }
        const seriesPatch = progress.series;
        if (seriesPatch) {
          setMetricSeries((previous) => mergeMetricSeries(previous, seriesPatch));
        }
      });
      workerRunRef.current = workerRun;

      const measured = await workerRun.promise;
      workerRun.terminate();
      if (workerRunRef.current === workerRun) {
        workerRunRef.current = null;
      }

      if (testRunIdRef.current === runId) {
        setPhase("saving");
      }
      const saved = await saveResult(measured);
      if (testRunIdRef.current === runId) {
        setResult(measured);
        setTransferMegabits(latestTransferMegabits);
        setRecent((items) => [saved, ...items.filter((item) => item.id !== saved.id)].slice(0, 50));
        setProgressPercent(100);
        setPhase("complete");
      }
    } catch (runError) {
      if (isSpeedTestWorkerAbort(runError)) return;
      if (testRunIdRef.current === runId) {
        setError(runError instanceof Error ? runError.message : "Test failed");
        setPhase("error");
      }
    } finally {
      if (workerRun && workerRunRef.current === workerRun) {
        workerRun.terminate();
        workerRunRef.current = null;
      }
      await finishActiveSessionForRun(sessionId, runId);
    }
  }

  const buttonLabel = phase === "complete" || phase === "error" ? "Retest" : "Start";
  const primaryMetrics = metrics.slice(0, 2);
  const secondaryMetrics = metrics.slice(2);
  const selectedMetric = selectedMetricLabel ? (metrics.find((metric) => metric.label === selectedMetricLabel) ?? null) : null;

  return (
    <main className="app-shell">
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
          <div className="server-pill">
            <Server size={17} />
            <span>v{__APP_VERSION__}</span>
          </div>
        </div>
      </header>

      {localClientWarning ? (
        <section className="local-warning" role="status" aria-live="polite">
          <TriangleAlert size={20} />
          <div>
            <strong>Local self-test detected</strong>
            <p>{localClientWarning} Open this page from another device to run a valid intranet speed test.</p>
          </div>
        </section>
      ) : null}

      {concurrencyWarning ? (
        <section className={`capacity-warning${concurrencyFull ? " is-full" : ""}`} role="status" aria-live="polite">
          <UsersRound size={20} />
          <div>
            <strong>{concurrencyFull ? "Test capacity is full" : "Multiple active tests detected"}</strong>
            <p>
              {concurrencyFull
                ? `All ${activeStatus.maxActiveTests} speed-test slots are in use. Try again after another test finishes.`
                : `${activeTests} people are testing now. Results may affect each other until active tests finish.`}
            </p>
          </div>
        </section>
      ) : null}

      <section className="test-panel" aria-live="polite">
        <div className="test-panel-main">
          <div className={`speed-test-display phase-${phase}${phase === "complete" ? ` summary-${completionSummary.verdict}` : ""}`}>
            {phase === "complete" ? (
              <CompletionSummaryPanel summary={completionSummary} />
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
                      : phaseText(phase, result, completionSummary)}
                </p>
              )}
            </div>
            <TransferSummary downloadMegabits={transferMegabits.download} uploadMegabits={transferMegabits.upload} />
            <button className="primary-action" type="button" disabled={!config || isRunning || testBlocked || concurrencyFull} onClick={() => void startTest()}>
              {isRunning ? <Loader2 className="spin" size={20} /> : <RotateCw size={20} />}
              <span>{testBlocked ? "Blocked" : concurrencyFull ? "Full" : isRunning ? "Running" : buttonLabel}</span>
            </button>

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
        <HistoryBars results={recent} />
      </section>

      {selectedMetric ? <MetricDetailModal metric={selectedMetric} onClose={() => setSelectedMetricLabel(null)} /> : null}
    </main>
  );

  async function refreshActiveTests() {
    try {
      const next = await loadActiveTests();
      setActiveStatus(next);
    } catch {
      // Active count is informational; avoid disrupting the speed-test workflow.
    }
  }

  function startHeartbeat(sessionId: string) {
    stopHeartbeat();
    heartbeatTimerRef.current = window.setInterval(() => {
      void heartbeatActiveTestSession(sessionId)
        .then((next) => setActiveStatus(next))
        .catch(() => undefined);
    }, 3000);
  }

  function stopHeartbeat() {
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }

  function terminateCurrentWorkerRun() {
    if (workerRunRef.current) {
      workerRunRef.current.terminate();
      workerRunRef.current = null;
    }
  }

  async function finishActiveSessionForRun(sessionId: string | null, runId: number) {
    if (!sessionId) return;

    const isCurrentRun = testRunIdRef.current === runId && activeSessionRef.current === sessionId;
    if (isCurrentRun) {
      stopHeartbeat();
      activeSessionRef.current = null;
    }

    try {
      const next = await finishActiveTestSession(sessionId);
      if (isCurrentRun) {
        setActiveStatus(next);
      }
    } catch {
      if (isCurrentRun) {
        await refreshActiveTests();
      }
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
    setError(null);
    try {
      await deleteRecentResults();
      setRecent([]);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete recent results");
      setPhase("error");
    } finally {
      setIsDeletingRecent(false);
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

function CompletionSummaryPanel({ summary }: { summary: CompletionSummary }) {
  return (
    <div className="completion-summary" aria-label="Test summary">
      <div>
        <span className="completion-summary-kicker">Test Summary</span>
        <strong className="completion-summary-title">{summary.title}</strong>
        <p className="completion-summary-subtitle">{summary.subtitle}</p>
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

function HistoryBars({ results }: { results: SavedResult[] }) {
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
          <div
            aria-describedby={tooltipId}
            aria-label={historyItemLabel(item)}
            className={`history-item${item.isLocalClient ? " is-local" : ""} ${historyTooltipPlacement(index, visible.length)}`}
            key={item.id}
            role="group"
            tabIndex={0}
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
            </div>
          </div>
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
      <span>Low P10 {formatNumber(stats.p10Mbps)}</span>
      <span>High P90 {formatNumber(stats.p90Mbps)}</span>
      <span>{stats.sampleCount} samples</span>
    </div>
  );
}

function MetricStatsPanel({ stats }: { stats: ThroughputStats }) {
  return (
    <div className="metric-stats-panel" aria-label="Throughput percentile summary">
      <StatTile label="P10 Low" value={stats.p10Mbps} />
      <StatTile label="P50 Typical" value={stats.p50Mbps} />
      <StatTile label="P90 High" value={stats.p90Mbps} />
      <div className="metric-stat-tile">
        <span>Samples</span>
        <strong>{stats.sampleCount}</strong>
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

function mergeMetricSeries(previous: MetricSeries, next: Partial<MetricSeries>): MetricSeries {
  return {
    downloadMbps: next.downloadMbps ? [...next.downloadMbps] : previous.downloadMbps,
    uploadMbps: next.uploadMbps ? [...next.uploadMbps] : previous.uploadMbps,
    idleLatencyMs: next.idleLatencyMs ? [...next.idleLatencyMs] : previous.idleLatencyMs,
    loadedLatencyMs: next.loadedLatencyMs ? [...next.loadedLatencyMs] : previous.loadedLatencyMs,
    jitterMs: next.jitterMs ? [...next.jitterMs] : previous.jitterMs,
    httpLossPercent: next.httpLossPercent ? [...next.httpLossPercent] : previous.httpLossPercent
  };
}

function emptyThroughputStats(): ThroughputStats {
  return {
    p10Mbps: 0,
    p50Mbps: 0,
    p90Mbps: 0,
    sampleCount: 0
  };
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
  return `${localPrefix}${formatDateTime(item.createdAt)}, Download ${formatNumber(item.downloadMbps)} Mbps, Upload ${formatNumber(item.uploadMbps)} Mbps`;
}

function historyTooltipPlacement(index: number, total: number): string {
  if (index <= 1) return "tooltip-left";
  if (index >= total - 2) return "tooltip-right";
  return "tooltip-center";
}
