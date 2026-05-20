export const CAT_SPEED_STAGES = ["idle", "walk", "jog", "run", "sprint"] as const;
export const BROWSER_CLIENT_ID_HEADER = "X-Ping-Pong-Browser-Id";

export type CatSpeedStage = (typeof CAT_SPEED_STAGES)[number];

export type CatSpeedRange = {
  minMbps: number;
  maxMbps: number | null;
};

export type CatSpeedRanges = Record<CatSpeedStage, CatSpeedRange>;

export const DEFAULT_CAT_SPEED_RANGES: CatSpeedRanges = {
  idle: { minMbps: 0, maxMbps: 0 },
  walk: { minMbps: 0, maxMbps: 50 },
  jog: { minMbps: 50, maxMbps: 200 },
  run: { minMbps: 200, maxMbps: 800 },
  sprint: { minMbps: 800, maxMbps: null }
};

export type RuntimeConfigResponse = {
  serverName: string;
  defaultTestDurationSeconds: number;
  parallelConnections: number;
  maxTestBytes: number;
  catSpeedRanges: CatSpeedRanges;
  clientSafety: ClientSafety;
};

export type ReportContextResponse = {
  serverTime: string;
  serverName: string;
  requestHost: string;
  requestProtocol: string;
  clientIp: string;
  coarseIp: string;
  ipSource: "direct-request-ip" | "trusted-proxy-request-ip";
  trustProxyAware: boolean;
  browserFamily: string;
  clientSafety: ClientSafety;
};

export type EditableRuntimeSettings = {
  testServerName: string;
  historyRetentionDays: number;
  defaultTestDurationSeconds: number;
  parallelConnections: number;
  maxTestBytes: number;
  allowLocalSelfTest: boolean;
  requireAdminLoginOnLeave: boolean;
  activeTestWarningThreshold: number;
  maxActiveTests: number;
  catSpeedRanges: CatSpeedRanges;
};

export type StartupSettings = {
  port: number;
  host: string;
  sqlitePath: string;
  trustProxy: boolean;
};

export type AdminSessionResponse = {
  configured: boolean;
  authenticated: boolean;
  expiresAt: string | null;
  sessionTtlHours: number;
};

export type AdminSettingsResponse = {
  settings: EditableRuntimeSettings;
  startup: StartupSettings;
};

export type ResultStats = {
  totalResults: number;
  localResults: number;
  oldestResultAt: string | null;
  newestResultAt: string | null;
};

export type AdminStatusResponse = {
  activeTests: ActiveTestsResponse;
  resultStats: ResultStats;
  startup: StartupSettings;
};

export type AdminEvent = {
  id: number;
  createdAt: string;
  action: string;
  metadata: Record<string, unknown>;
};

export type AdminMaintenanceResponse = {
  ok: true;
  changed: number;
};

export type ResultPayload = {
  downloadMbps: number;
  uploadMbps: number;
  downloadStats: ThroughputStats;
  uploadStats: ThroughputStats;
  idleLatencyMs: number;
  downloadLoadedLatencyMs: number;
  uploadLoadedLatencyMs: number;
  jitterMs: number;
  httpLossPercent: number;
  durationSeconds: number;
  parallelConnections: number;
};

export type ThroughputStats = {
  meanMbps: number;
  p10Mbps: number;
  p50Mbps: number;
  p75Mbps: number;
  p90Mbps: number;
  cvPercent: number;
  sampleCount: number;
  filteredSampleCount: number;
};

export type SavedResult = ResultPayload & {
  id: number;
  createdAt: string;
  serverName: string;
  browserFamily: string;
  clientId: string;
  isLocalClient: boolean;
};

export type ActiveTestsResponse = {
  activeTests: number;
  warningThreshold: number;
  maxActiveTests: number;
  isWarning: boolean;
  isFull: boolean;
  updatedAt: string;
};

export type ActiveTestSessionResponse = ActiveTestsResponse & {
  sessionId: string;
};

export type ClientSafety = {
  isLocalClient: boolean;
  canRunTest: boolean;
  reason: "loopback" | "server-address" | null;
  message: string | null;
};

export function cloneCatSpeedRanges(ranges: CatSpeedRanges): CatSpeedRanges {
  return Object.fromEntries(CAT_SPEED_STAGES.map((stage) => [stage, { ...ranges[stage] }])) as CatSpeedRanges;
}

export function normalizeCatSpeedRanges(value: unknown): CatSpeedRanges {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return cloneCatSpeedRanges(DEFAULT_CAT_SPEED_RANGES);
  }

  const candidate = value as Partial<Record<CatSpeedStage, Partial<CatSpeedRange>>>;
  const ranges = cloneCatSpeedRanges(DEFAULT_CAT_SPEED_RANGES);
  for (const stage of CAT_SPEED_STAGES) {
    const range = candidate[stage];
    if (!range || typeof range !== "object") {
      continue;
    }

    if (typeof range.minMbps === "number") {
      ranges[stage].minMbps = range.minMbps;
    }
    if (range.maxMbps === null || typeof range.maxMbps === "number") {
      ranges[stage].maxMbps = range.maxMbps;
    }
  }

  return catSpeedRangeValidationMessage(ranges) ? cloneCatSpeedRanges(DEFAULT_CAT_SPEED_RANGES) : ranges;
}

export function catSpeedRangeValidationMessage(ranges: CatSpeedRanges): string | null {
  let previousMax: number | null = null;

  for (const [index, stage] of CAT_SPEED_STAGES.entries()) {
    const range = ranges[stage];
    if (!Number.isFinite(range.minMbps) || range.minMbps < 0) {
      return `${stage}.minMbps must be a non-negative finite number`;
    }

    if (index === 0 && !sameBoundary(range.minMbps, 0)) {
      return "idle.minMbps must be 0";
    }

    if (index > 0 && (previousMax === null || !sameBoundary(range.minMbps, previousMax))) {
      return `${stage}.minMbps must match the previous maxMbps`;
    }

    if (stage === "sprint") {
      if (range.maxMbps !== null) {
        return "sprint.maxMbps must be null";
      }
      continue;
    }

    if (range.maxMbps === null || !Number.isFinite(range.maxMbps) || range.maxMbps < 0) {
      return `${stage}.maxMbps must be a non-negative finite number`;
    }

    if (index === 0 ? range.maxMbps < range.minMbps : range.maxMbps <= range.minMbps) {
      return `${stage}.maxMbps must be greater than minMbps`;
    }

    previousMax = range.maxMbps;
  }

  return null;
}

export function catSpeedStageForMbps(value: number, ranges: CatSpeedRanges): CatSpeedStage {
  const idleMax = ranges.idle.maxMbps ?? 0;
  if (!Number.isFinite(value) || value <= idleMax) {
    return "idle";
  }

  for (const stage of CAT_SPEED_STAGES) {
    const range = ranges[stage];
    if (value > range.minMbps && (range.maxMbps === null || value <= range.maxMbps)) {
      return stage;
    }
  }

  return "sprint";
}

function sameBoundary(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.000001;
}
