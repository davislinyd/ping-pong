import { API_BASE } from "./api-base";
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
export type { MetricSeries, TestPhase, TestProgress } from "./speed-test-core";

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
  const response = await fetch(`${API_BASE}/api/active-tests`, {
    method: "POST",
    cache: "no-store"
  });
  if (!response.ok) {
    if (response.status === 429) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(body?.message ?? "Too many users are running speed tests right now.");
    }

    throw new Error(`Failed to start active test session: ${response.status}`);
  }

  return (await response.json()) as ActiveTestSessionResponse;
}

export async function heartbeatActiveTestSession(sessionId: string): Promise<ActiveTestsResponse> {
  const response = await fetch(`${API_BASE}/api/active-tests/${encodeURIComponent(sessionId)}/heartbeat`, {
    method: "POST",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Failed to heartbeat active test session: ${response.status}`);
  }

  return (await response.json()) as ActiveTestsResponse;
}

export async function finishActiveTestSession(sessionId: string): Promise<ActiveTestsResponse> {
  const response = await fetch(`${API_BASE}/api/active-tests/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Failed to finish active test session: ${response.status}`);
  }

  return (await response.json()) as ActiveTestsResponse;
}

export async function saveResult(payload: ResultPayload): Promise<SavedResult> {
  const response = await fetch(`${API_BASE}/api/results`, {
    method: "POST",
    headers: {
      ...browserClientHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(`Failed to save result: ${response.status}`);
  }

  return (await response.json()) as SavedResult;
}

export async function deleteRecentResults(): Promise<{ ok: true; changed: number }> {
  const response = await fetch(`${API_BASE}/api/results`, {
    method: "DELETE",
    headers: browserClientHeaders(),
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(`Failed to delete recent results: ${response.status}`);
  }

  return (await response.json()) as { ok: true; changed: number };
}

async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, { ...init, cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
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
