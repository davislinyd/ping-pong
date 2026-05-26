import type { ResultPayload, RuntimeConfigResponse, ThroughputStats } from "../shared/contracts";
import { bytesToMegabits, bytesToMbps, filterIqrOutliers, jitter, lossPercent, median, roundTo, throughputStatsFromSamples, type ThroughputSample } from "../shared/metrics";
import { API_BASE } from "./api-base";

export type TestPhase = "idle" | "latency" | "download" | "upload" | "saving" | "complete" | "error";

export type MetricSeries = {
  downloadMbps: number[];
  uploadMbps: number[];
  idleLatencyMs: number[];
  loadedLatencyMs: number[];
  jitterMs: number[];
  httpLossPercent: number[];
};

export type TestProgress = {
  phase: TestPhase;
  label: string;
  currentMbps?: number | null;
  progressPercent?: number;
  downloadMegabits?: number;
  uploadMegabits?: number;
  partial?: Partial<ResultPayload>;
  series?: Partial<MetricSeries>;
};

type LatencySet = {
  samples: number[];
  sent: number;
  failed: number;
};

const DOWNLOAD_CHUNK_BYTES = 16_777_216;
const UPLOAD_CHUNK_BYTES = 262_144;
const LATENCY_INTERVAL_MS = 300;
const THROUGHPUT_SAMPLE_INTERVAL_MS = 250;
const WARMUP_MS = 1000;

export function createEmptyMetricSeries(): MetricSeries {
  return {
    downloadMbps: [],
    uploadMbps: [],
    idleLatencyMs: [],
    loadedLatencyMs: [],
    jitterMs: [],
    httpLossPercent: []
  };
}

export async function runSpeedTest(
  config: RuntimeConfigResponse,
  onProgress: (progress: TestProgress) => void,
  signal: AbortSignal
): Promise<ResultPayload> {
  const series = createEmptyMetricSeries();
  let latencySent = 0;
  let latencyFailed = 0;

  function recordLatencySample(sample: number | null, target: "idle" | "loaded") {
    latencySent += 1;
    if (sample === null) {
      latencyFailed += 1;
    } else if (target === "idle") {
      series.idleLatencyMs.push(sample);
    } else {
      series.loadedLatencyMs.push(sample);
    }
    series.httpLossPercent.push(lossPercent(latencySent, latencyFailed));
  }

  onProgress({ phase: "latency", label: "Idle latency", progressPercent: 0 });
  const idleLatency = await latencySamples(10, signal, (sample, completed, total) => {
    recordLatencySample(sample, "idle");
    series.jitterMs.push(jitter(series.idleLatencyMs));
    onProgress({
      phase: "latency",
      label: "Idle latency",
      progressPercent: percentFromRatio(completed / total),
      series: cloneMetricSeries(series)
    });
  });
  const idleLatencyMs = median(filterIqrOutliers(idleLatency.samples));
  const jitterMs = jitter(idleLatency.samples);

  onProgress({
    phase: "latency",
    label: "Idle latency",
    progressPercent: 100,
    partial: { idleLatencyMs, jitterMs, httpLossPercent: lossPercent(idleLatency.sent, idleLatency.failed) },
    series: cloneMetricSeries(series)
  });

  onProgress({ phase: "download", label: "Download", currentMbps: null, progressPercent: 0, series: cloneMetricSeries(series) });
  const download = await measureDownload(
    config,
    signal,
    (currentMbps, phaseProgress) => {
      series.downloadMbps.push(currentMbps);
      onProgress({
        phase: "download",
        label: "Download",
        currentMbps,
        progressPercent: percentFromRatio(phaseProgress),
        series: cloneMetricSeries(series)
      });
    },
    (phaseProgress) => {
      onProgress({ phase: "download", label: "Download", progressPercent: percentFromRatio(phaseProgress), series: cloneMetricSeries(series) });
    },
    (sample) => {
      recordLatencySample(sample, "loaded");
      onProgress({ phase: "download", label: "Download", series: cloneMetricSeries(series) });
    },
    (megabits) => {
      onProgress({ phase: "download", label: "Download", downloadMegabits: megabits });
    }
  );

  onProgress({
    phase: "download",
    label: "Download",
    currentMbps: download.mbps,
    progressPercent: 100,
    downloadMegabits: download.megabits,
    partial: { downloadMbps: download.mbps, downloadStats: download.stats, downloadLoadedLatencyMs: median(filterIqrOutliers(download.loadedLatency.samples)) },
    series: cloneMetricSeries(series)
  });

  onProgress({ phase: "upload", label: "Upload", currentMbps: null, progressPercent: 0, series: cloneMetricSeries(series) });
  const upload = await measureUpload(
    config,
    signal,
    (currentMbps, phaseProgress) => {
      series.uploadMbps.push(currentMbps);
      onProgress({
        phase: "upload",
        label: "Upload",
        currentMbps,
        progressPercent: percentFromRatio(phaseProgress),
        series: cloneMetricSeries(series)
      });
    },
    (phaseProgress) => {
      onProgress({ phase: "upload", label: "Upload", progressPercent: percentFromRatio(phaseProgress), series: cloneMetricSeries(series) });
    },
    (sample) => {
      recordLatencySample(sample, "loaded");
      onProgress({ phase: "upload", label: "Upload", series: cloneMetricSeries(series) });
    },
    (megabits) => {
      onProgress({ phase: "upload", label: "Upload", uploadMegabits: megabits });
    }
  );

  const totalSent = idleLatency.sent + download.loadedLatency.sent + upload.loadedLatency.sent;
  const totalFailed = idleLatency.failed + download.loadedLatency.failed + upload.loadedLatency.failed;

  const result: ResultPayload = {
    downloadMbps: download.mbps,
    uploadMbps: upload.mbps,
    downloadStats: download.stats,
    uploadStats: upload.stats,
    idleLatencyMs,
    downloadLoadedLatencyMs: median(filterIqrOutliers(download.loadedLatency.samples)),
    uploadLoadedLatencyMs: median(filterIqrOutliers(upload.loadedLatency.samples)),
    jitterMs,
    httpLossPercent: lossPercent(totalSent, totalFailed),
    durationSeconds: config.defaultTestDurationSeconds,
    parallelConnections: config.parallelConnections,
    networkLinkType: "unknown"
  };

  onProgress({
    phase: "saving",
    label: "Saving",
    progressPercent: 100,
    downloadMegabits: download.megabits,
    uploadMegabits: upload.megabits,
    partial: result,
    series: cloneMetricSeries(series)
  });
  return result;
}

async function latencySamples(count: number, signal: AbortSignal, onSample?: (sample: number | null, completed: number, total: number) => void): Promise<LatencySet> {
  const result: LatencySet = { samples: [], sent: 0, failed: 0 };

  for (let index = 0; index < count; index += 1) {
    const sample = await latencyOnce(signal);
    result.sent += 1;
    if (sample === null) {
      result.failed += 1;
    } else {
      result.samples.push(sample);
    }
    onSample?.(sample, index + 1, count);
    await delay(90, signal);
  }

  return result;
}

async function collectLoadedLatency(stopAt: number, signal: AbortSignal, onSample?: (sample: number | null) => void): Promise<LatencySet> {
  const result: LatencySet = { samples: [], sent: 0, failed: 0 };

  while (performance.now() < stopAt && !signal.aborted) {
    const sample = await latencyOnce(signal);
    result.sent += 1;
    if (sample === null) {
      result.failed += 1;
    } else {
      result.samples.push(sample);
    }
    onSample?.(sample);
    await delay(LATENCY_INTERVAL_MS, signal);
  }

  return result;
}

async function latencyOnce(signal: AbortSignal): Promise<number | null> {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${API_BASE}/api/latency?nonce=${nonce()}`, {
      cache: "no-store",
      signal
    });
    if (!response.ok) return null;
    await response.arrayBuffer();
    return roundTo(performance.now() - startedAt, 2);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}

async function measureDownload(
  config: RuntimeConfigResponse,
  signal: AbortSignal,
  onMbps: (currentMbps: number, phaseProgress: number) => void,
  onPhaseProgress?: (phaseProgress: number) => void,
  onLoadedLatencySample?: (sample: number | null) => void,
  onMegabits?: (megabits: number) => void
): Promise<{ mbps: number; megabits: number; stats: ThroughputStats; loadedLatency: LatencySet }> {
  const durationMs = config.defaultTestDurationSeconds * 1000;
  const startedAt = performance.now();
  const warmupUntil = startedAt + Math.min(WARMUP_MS, durationMs / 3);
  const stopAt = startedAt + durationMs;
  const chunkBytes = Math.min(config.maxTestBytes, DOWNLOAD_CHUNK_BYTES);
  let measurementBytes = 0;
  const throughputSamples: ThroughputSample[] = [];
  const sampler = createThroughputSampler(warmupUntil, throughputSamples, onMbps, (now) => phaseProgress(startedAt, stopAt, now));
  const progress = createProgressReporter(startedAt, stopAt, onPhaseProgress);

  const loadedLatencyPromise = collectLoadedLatency(stopAt, signal, onLoadedLatencySample);

  const workers = Array.from({ length: config.parallelConnections }, async () => {
    while (performance.now() < stopAt && !signal.aborted) {
      const response = await fetch(`${API_BASE}/api/download?bytes=${chunkBytes}&nonce=${nonce()}`, {
        cache: "no-store",
        signal
      });
      if (!response.ok || !response.body) {
        throw new Error(`Download request failed: ${response.status}`);
      }

      const reader = response.body.getReader();
      try {
        while (performance.now() < stopAt) {
          const read = await reader.read();
          if (read.done) break;
          const now = performance.now();
          if (now >= warmupUntil) {
            measurementBytes += read.value.byteLength;
            sampler.record(read.value.byteLength, now);
            onMegabits?.(bytesToMegabits(measurementBytes));
          }
          progress.report(now);
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        try {
          reader.releaseLock();
        } catch {
          // Aborted reads can transiently keep a pending read request.
        }
      }
    }
  });

  await Promise.all(workers);
  const endedAt = performance.now();
  sampler.flush(endedAt);
  const loadedLatency = await loadedLatencyPromise;
  const measurementElapsedMs = Math.max(1, endedAt - warmupUntil);
  const stats = throughputStatsFromSamples(throughputSamples, measurementBytes, measurementElapsedMs);
  const mbps = stats.meanMbps;
  const megabits = bytesToMegabits(measurementBytes);
  onPhaseProgress?.(1);
  onMegabits?.(megabits);

  return { mbps, megabits, stats, loadedLatency };
}

async function measureUpload(
  config: RuntimeConfigResponse,
  signal: AbortSignal,
  onMbps: (currentMbps: number, phaseProgress: number) => void,
  onPhaseProgress?: (phaseProgress: number) => void,
  onLoadedLatencySample?: (sample: number | null) => void,
  onMegabits?: (megabits: number) => void
): Promise<{ mbps: number; megabits: number; stats: ThroughputStats; loadedLatency: LatencySet }> {
  const durationMs = config.defaultTestDurationSeconds * 1000;
  const startedAt = performance.now();
  const warmupUntil = startedAt + Math.min(WARMUP_MS, durationMs / 3);
  const stopAt = startedAt + durationMs;
  const payloadBytes = Math.min(config.maxTestBytes, UPLOAD_CHUNK_BYTES);
  let measurementBytes = 0;
  const throughputSamples: ThroughputSample[] = [];
  const sampler = createThroughputSampler(warmupUntil, throughputSamples, onMbps, (now) => phaseProgress(startedAt, stopAt, now));
  const progress = createProgressReporter(startedAt, stopAt, onPhaseProgress);

  const loadedLatencyPromise = collectLoadedLatency(stopAt, signal, onLoadedLatencySample);

  const workers = Array.from({ length: config.parallelConnections }, async () => {
    const uploadBody = new Uint8Array(payloadBytes);

    while (performance.now() < stopAt && !signal.aborted) {
      const request = linkedSignal(signal, Math.max(1000, stopAt - performance.now() + 750));
      const requestStartedAt = performance.now();
      try {
        const response = await fetch(`${API_BASE}/api/upload?nonce=${nonce()}`, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream"
          },
          body: uploadBody,
          cache: "no-store",
          signal: request.signal
        });

        if (!response.ok) {
          throw new Error(`Upload request failed: ${response.status}`);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        if (performance.now() >= stopAt) break;
        throw error;
      } finally {
        request.cleanup();
      }

      const now = performance.now();
      if (requestStartedAt >= warmupUntil && now <= stopAt) {
        measurementBytes += payloadBytes;
        sampler.record(payloadBytes, now);
        onMegabits?.(bytesToMegabits(measurementBytes));
      }
      progress.report(now);
    }
  });

  await Promise.all(workers);
  const endedAt = performance.now();
  sampler.flush(endedAt);
  const loadedLatency = await loadedLatencyPromise;
  const measurementElapsedMs = Math.max(1, endedAt - warmupUntil);
  const stats = throughputStatsFromSamples(throughputSamples, measurementBytes, measurementElapsedMs);
  const mbps = stats.meanMbps;
  const megabits = bytesToMegabits(measurementBytes);
  onPhaseProgress?.(1);
  onMegabits?.(megabits);

  return { mbps, megabits, stats, loadedLatency };
}

function createThroughputSampler(
  measurementStartedAt: number,
  samples: ThroughputSample[],
  onMbps: (currentMbps: number, phaseProgress: number) => void,
  progressAt: (now: number) => number
) {
  let windowStartedAt = measurementStartedAt;
  let windowBytes = 0;

  function flush(now: number) {
    const elapsedMs = now - windowStartedAt;
    if (elapsedMs < THROUGHPUT_SAMPLE_INTERVAL_MS && samples.length > 0) return;

    const sample = { bytes: windowBytes, elapsedMs: Math.max(1, elapsedMs) };
    samples.push(sample);
    onMbps(bytesToMbps(sample.bytes, sample.elapsedMs), progressAt(now));
    windowBytes = 0;
    windowStartedAt = now;
  }

  return {
    record(bytes: number, now: number) {
      windowBytes += bytes;
      if (now - windowStartedAt >= THROUGHPUT_SAMPLE_INTERVAL_MS) {
        flush(now);
      }
    },
    flush(now: number) {
      if (windowBytes > 0 || samples.length === 0 || now - windowStartedAt >= THROUGHPUT_SAMPLE_INTERVAL_MS) {
        flush(now);
      }
    }
  };
}

function createProgressReporter(startedAt: number, stopAt: number, onPhaseProgress?: (phaseProgress: number) => void) {
  let lastProgressAt = startedAt;

  return {
    report(now: number) {
      if (!onPhaseProgress || now - lastProgressAt < 160) return;
      onPhaseProgress(phaseProgress(startedAt, stopAt, now));
      lastProgressAt = now;
    }
  };
}

function phaseProgress(startedAt: number, stopAt: number, now = performance.now()): number {
  return clamp((now - startedAt) / Math.max(1, stopAt - startedAt), 0, 1);
}

function percentFromRatio(ratio: number): number {
  return roundTo(clamp(ratio, 0, 1) * 100, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function cloneMetricSeries(series: MetricSeries): MetricSeries {
  return {
    downloadMbps: [...series.downloadMbps],
    uploadMbps: [...series.uploadMbps],
    idleLatencyMs: [...series.idleLatencyMs],
    loadedLatencyMs: [...series.loadedLatencyMs],
    jitterMs: [...series.jitterMs],
    httpLossPercent: [...series.httpLossPercent]
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        globalThis.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function linkedSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = globalThis.setTimeout(() => {
    controller.abort(new DOMException("Timed out", "TimeoutError"));
  }, timeoutMs);
  const abort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", abort, { once: true });

  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      parent.removeEventListener("abort", abort);
    }
  };
}

function nonce(): string {
  const browserCrypto = globalThis.crypto;

  if (browserCrypto && typeof browserCrypto.randomUUID === "function") {
    return browserCrypto.randomUUID();
  }

  if (browserCrypto && typeof browserCrypto.getRandomValues === "function") {
    const values = new Uint32Array(4);
    browserCrypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
