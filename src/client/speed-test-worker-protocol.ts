import type { NetworkLinkType, ResultPayload, RuntimeConfigResponse } from "../shared/contracts";
import type { RawTestData, TestProgress } from "./speed-test-core";

export type SpeedTestWorkerRequest = {
  type: "start";
  config: RuntimeConfigResponse;
  networkLinkType?: NetworkLinkType;
};

export type SpeedTestWorkerMessage =
  | {
      type: "progress";
      progress: TestProgress;
    }
  | {
      type: "complete";
      result: ResultPayload;
      rawData: RawTestData;
    }
  | {
      type: "error";
      message: string;
    };
