import { ApiError, deleteJson, fetchJson, postJson } from "./api-base";
import {
  BROWSER_CLIENT_ID_HEADER,
  type ActiveTestSessionResponse,
  type ActiveTestsResponse,
  type ReportContextResponse,
  type ResultPayload,
  type RuntimeConfigResponse,
  type SavedResult
} from "../shared/contracts";

export { createEmptyMetricSeries } from "./speed-test-core";
export type { MetricSeries, RawTestData, TestPhase, TestProgress } from "./speed-test-core";

const BROWSER_CLIENT_STORAGE_KEY = "ping-pong.browserClientId";
const BROWSER_CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

let memoryBrowserClientId: string | null = null;

export async function loadRuntimeConfig(): Promise<RuntimeConfigResponse> {
  return fetchJson<RuntimeConfigResponse>("/api/config");
}

export async function loadRecentResults(limit = 50): Promise<SavedResult[]> {
  return fetchJson<SavedResult[]>(`/api/results/recent?limit=${limit}&includeLocal=true`, {
    headers: browserClientHeaders()
  });
}

export async function loadActiveTests(): Promise<ActiveTestsResponse> {
  return fetchJson<ActiveTestsResponse>("/api/active-tests");
}

export async function loadReportContext(): Promise<ReportContextResponse> {
  return fetchJson<ReportContextResponse>("/api/report-context");
}

export async function startActiveTestSession(): Promise<ActiveTestSessionResponse> {
  try {
    return await postJson<ActiveTestSessionResponse>("/api/active-tests");
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) {
      const message = (error.body?.message as string | undefined) ?? "Too many users are running speed tests right now.";
      throw new Error(message);
    }
    throw error;
  }
}

export async function heartbeatActiveTestSession(sessionId: string): Promise<ActiveTestsResponse> {
  return postJson<ActiveTestsResponse>(`/api/active-tests/${encodeURIComponent(sessionId)}/heartbeat`);
}

export async function finishActiveTestSession(sessionId: string): Promise<ActiveTestsResponse> {
  return deleteJson<ActiveTestsResponse>(`/api/active-tests/${encodeURIComponent(sessionId)}`);
}

export async function saveResult(payload: ResultPayload): Promise<SavedResult> {
  return postJson<SavedResult>("/api/results", {
    headers: { ...browserClientHeaders(), "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
}

export async function deleteRecentResults(): Promise<{ ok: true; changed: number }> {
  return deleteJson<{ ok: true; changed: number }>("/api/results", {
    headers: browserClientHeaders()
  });
}

function browserClientHeaders(): Record<string, string> {
  return {
    [BROWSER_CLIENT_ID_HEADER]: browserClientId()
  };
}

function browserClientId(): string {
  if (memoryBrowserClientId) {
    return memoryBrowserClientId;
  }

  const stored = readStoredBrowserClientId();
  if (stored) {
    memoryBrowserClientId = stored;
    return stored;
  }

  memoryBrowserClientId = createBrowserClientId();
  try {
    window.localStorage.setItem(BROWSER_CLIENT_STORAGE_KEY, memoryBrowserClientId);
  } catch {
    // Private browsing or restricted storage still gets a stable in-page id.
  }

  return memoryBrowserClientId;
}

function readStoredBrowserClientId(): string | null {
  try {
    const value = window.localStorage.getItem(BROWSER_CLIENT_STORAGE_KEY);
    return value && BROWSER_CLIENT_ID_PATTERN.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

function createBrowserClientId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}
