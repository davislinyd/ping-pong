import { runSpeedTest } from "./speed-test-core";
import type { SpeedTestWorkerMessage, SpeedTestWorkerRequest } from "./speed-test-worker-protocol";

type SpeedTestWorkerScope = {
  addEventListener(type: "message", listener: (event: MessageEvent<SpeedTestWorkerRequest>) => void): void;
  postMessage(message: SpeedTestWorkerMessage): void;
};

const workerScope = self as unknown as SpeedTestWorkerScope;
let started = false;

workerScope.addEventListener("message", (event: MessageEvent<SpeedTestWorkerRequest>) => {
  if (event.data.type !== "start") return;

  if (started) {
    postWorkerMessage({ type: "error", message: "Speed test worker already started." });
    return;
  }

  started = true;
  const controller = new AbortController();
  void runSpeedTest(
    event.data.config,
    event.data.networkLinkType ?? "unknown",
    (progress) => postWorkerMessage({ type: "progress", progress }),
    controller.signal
  )
    .then((runResult) => postWorkerMessage({ type: "complete", result: runResult.result, rawData: runResult.rawData }))
    .catch((error: unknown) => {
      postWorkerMessage({ type: "error", message: errorMessage(error) });
    });
});

function postWorkerMessage(message: SpeedTestWorkerMessage) {
  workerScope.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Speed test worker failed.";
}
