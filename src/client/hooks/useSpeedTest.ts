import { useEffect, useRef, useState } from "react";

import { type ResultPayload, type RuntimeConfigResponse, type ThroughputStats } from "../../shared/contracts";
import { createEmptyMetricSeries, type MetricSeries, type TestPhase, type TestProgress } from "../speed-test-core";
import { isSpeedTestWorkerAbort, startSpeedTestWorker, type RunningSpeedTestWorker } from "../speed-test-worker-client";

export type SpeedTestHook = {
  phase: TestPhase;
  setPhase: (phase: TestPhase) => void;
  result: ResultPayload;
  currentMbps: number | null;
  progressPercent: number;
  metricSeries: MetricSeries;
  transferMegabits: { download: number; upload: number };
  error: string | null;
  setError: (error: string | null) => void;
  isRunning: boolean;
  run: (config: RuntimeConfigResponse) => Promise<{ measured: ResultPayload; runId: number }>;
  terminate: () => void;
  isCurrentRun: (runId: number) => boolean;
};

const emptyThroughputStats: ThroughputStats = {
  meanMbps: 0,
  p10Mbps: 0,
  p50Mbps: 0,
  p75Mbps: 0,
  p90Mbps: 0,
  cvPercent: 0,
  sampleCount: 0,
  filteredSampleCount: 0
};

const emptyResult: ResultPayload = {
  downloadMbps: 0,
  uploadMbps: 0,
  downloadStats: emptyThroughputStats,
  uploadStats: emptyThroughputStats,
  idleLatencyMs: 0,
  downloadLoadedLatencyMs: 0,
  uploadLoadedLatencyMs: 0,
  jitterMs: 0,
  httpLossPercent: 0,
  durationSeconds: 0,
  parallelConnections: 0
};

export function useSpeedTest(): SpeedTestHook {
  const [phase, setPhase] = useState<TestPhase>("idle");
  const [result, setResult] = useState<ResultPayload>(emptyResult);
  const [currentMbps, setCurrentMbps] = useState<number | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [metricSeries, setMetricSeries] = useState<MetricSeries>(() => createEmptyMetricSeries());
  const [transferMegabits, setTransferMegabits] = useState({ download: 0, upload: 0 });
  const [error, setError] = useState<string | null>(null);
  const workerRunRef = useRef<RunningSpeedTestWorker | null>(null);
  const testRunIdRef = useRef(0);

  const isRunning = ["latency", "download", "upload", "saving"].includes(phase);

  useEffect(() => {
    return () => {
      workerRunRef.current?.terminate();
    };
  }, []);

  function terminate() {
    if (workerRunRef.current) {
      workerRunRef.current.terminate();
      workerRunRef.current = null;
    }
  }

  function isCurrentRun(runId: number) {
    return testRunIdRef.current === runId;
  }

  async function run(config: RuntimeConfigResponse): Promise<{ measured: ResultPayload; runId: number }> {
    terminate();
    const runId = testRunIdRef.current + 1;
    testRunIdRef.current = runId;

    setResult({ ...emptyResult, durationSeconds: config.defaultTestDurationSeconds, parallelConnections: config.parallelConnections });
    setCurrentMbps(null);
    setProgressPercent(0);
    setMetricSeries(createEmptyMetricSeries());
    setTransferMegabits({ download: 0, upload: 0 });

    let latestTransfer = { download: 0, upload: 0 };

    const workerRun = startSpeedTestWorker(config, (progress: TestProgress) => {
      if (testRunIdRef.current !== runId) return;
      setPhase(progress.phase);
      if (progress.currentMbps !== undefined) setCurrentMbps(progress.currentMbps);
      if (typeof progress.progressPercent === "number") setProgressPercent(progress.progressPercent);
      if (typeof progress.downloadMegabits === "number" || typeof progress.uploadMegabits === "number") {
        latestTransfer = {
          download: typeof progress.downloadMegabits === "number" ? progress.downloadMegabits : latestTransfer.download,
          upload: typeof progress.uploadMegabits === "number" ? progress.uploadMegabits : latestTransfer.upload
        };
        setTransferMegabits({ ...latestTransfer });
      }
      if (progress.partial) setResult((prev) => ({ ...prev, ...progress.partial }));
      if (progress.series) setMetricSeries((prev) => mergeMetricSeries(prev, progress.series!));
    });
    workerRunRef.current = workerRun;

    try {
      const measured = await workerRun.promise;
      workerRun.terminate();
      if (workerRunRef.current === workerRun) workerRunRef.current = null;
      if (testRunIdRef.current === runId) {
        setResult(measured);
        setTransferMegabits({ ...latestTransfer });
        setProgressPercent(100);
      }
      return { measured, runId };
    } catch (err) {
      workerRun.terminate();
      if (workerRunRef.current === workerRun) workerRunRef.current = null;
      throw err;
    }
  }

  return {
    phase,
    setPhase,
    result,
    currentMbps,
    progressPercent,
    metricSeries,
    transferMegabits,
    error,
    setError,
    isRunning,
    run,
    terminate,
    isCurrentRun
  };
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
