import type { NetworkLinkType, RuntimeConfigResponse } from "../shared/contracts";
import type { SpeedTestRunResult, TestProgress } from "./speed-test-core";
import type { SpeedTestWorkerMessage, SpeedTestWorkerRequest } from "./speed-test-worker-protocol";

export type SpeedTestWorkerLike = {
  addEventListener(type: "message" | "error", listener: (event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) => void): void;
  removeEventListener(type: "message" | "error", listener: (event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) => void): void;
  postMessage(message: SpeedTestWorkerRequest): void;
  terminate(): void;
};

export type RunningSpeedTestWorker = {
  promise: Promise<SpeedTestRunResult>;
  terminate: () => void;
};

type CreateSpeedTestWorker = () => SpeedTestWorkerLike;
const SPEED_TEST_TIMEOUT_BUFFER_SECONDS = 20;

export function startSpeedTestWorker(
  config: RuntimeConfigResponse,
  networkLinkType: NetworkLinkType,
  onProgress: (progress: TestProgress) => void,
  createWorker: CreateSpeedTestWorker = createSpeedTestWorker
): RunningSpeedTestWorker {
  const worker = createWorker();
  let settled = false;
  let terminated = false;
  let cleanup: () => void = () => undefined;
  let rejectPromise: (error: Error | DOMException) => void = () => undefined;
  const timeoutMs = speedTestWorkerTimeoutMs(config.defaultTestDurationSeconds);
  const timeoutId = setTimeout(() => {
    rejectPromise(new DOMException("Speed test timed out", "TimeoutError"));
  }, timeoutMs);

  const promise = new Promise<SpeedTestRunResult>((resolve, reject) => {
    rejectPromise = reject;

    cleanup = () => {
      clearTimeout(timeoutId);
      worker.removeEventListener("message", handleMessage);
      worker.removeEventListener("error", handleError);
    };

    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };

    function handleMessage(event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) {
      if (!("data" in event)) return;

      const message = event.data;
      if (message.type === "progress") {
        if (!settled) {
          onProgress(message.progress);
        }
        return;
      }

      if (message.type === "complete") {
        settle(() => resolve({ result: message.result, rawData: message.rawData }));
        return;
      }

      settle(() => reject(new Error(message.message)));
    }

    function handleError(event: MessageEvent<SpeedTestWorkerMessage> | ErrorEvent) {
      const message = "message" in event && event.message ? event.message : "Speed test worker failed.";
      settle(() => reject(new Error(message)));
    }

    worker.addEventListener("message", handleMessage);
    worker.addEventListener("error", handleError);
    worker.postMessage({ type: "start", config, networkLinkType });
  });

  return {
    promise,
    terminate() {
      if (!terminated) {
        terminated = true;
        worker.terminate();
      }

      if (!settled) {
        settled = true;
        cleanup();
        rejectPromise(abortError());
      }
    }
  };
}

function speedTestWorkerTimeoutMs(durationSeconds: number): number {
  return (durationSeconds * 2 + SPEED_TEST_TIMEOUT_BUFFER_SECONDS) * 1000;
}

export function createSpeedTestWorker(): SpeedTestWorkerLike {
  if (typeof Worker === "undefined") {
    throw new Error("This browser does not support Web Worker speed tests.");
  }

  try {
    return new Worker(new URL("./speed-test-worker.ts", import.meta.url), { type: "module" }) as SpeedTestWorkerLike;
  } catch {
    throw new Error("This browser could not start the Web Worker speed test.");
  }
}

export function isSpeedTestWorkerAbort(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

function abortError(): Error | DOMException {
  if (typeof DOMException === "function") {
    return new DOMException("Speed test worker terminated.", "AbortError");
  }

  const error = new Error("Speed test worker terminated.");
  error.name = "AbortError";
  return error;
}
