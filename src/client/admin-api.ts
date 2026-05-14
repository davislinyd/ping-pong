import { API_BASE } from "./api-base";
import type {
  AdminEvent,
  AdminMaintenanceResponse,
  AdminSessionResponse,
  AdminSettingsResponse,
  AdminStatusResponse,
  EditableRuntimeSettings
} from "../shared/contracts";

export async function loadAdminSession(): Promise<AdminSessionResponse> {
  return adminFetch<AdminSessionResponse>("/api/admin/session");
}

export async function loginAdmin(password: string): Promise<AdminSessionResponse> {
  return adminFetch<AdminSessionResponse>("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
}

export async function logoutAdmin(): Promise<AdminSessionResponse> {
  return adminFetch<AdminSessionResponse>("/api/admin/logout", { method: "POST" });
}

export async function loadAdminSettings(): Promise<AdminSettingsResponse> {
  return adminFetch<AdminSettingsResponse>("/api/admin/settings");
}

export async function saveAdminSettings(patch: Partial<EditableRuntimeSettings>): Promise<AdminSettingsResponse> {
  return adminFetch<AdminSettingsResponse>("/api/admin/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch)
  });
}

export async function loadAdminStatus(): Promise<AdminStatusResponse> {
  return adminFetch<AdminStatusResponse>("/api/admin/status");
}

export async function loadAdminEvents(limit = 20): Promise<AdminEvent[]> {
  return adminFetch<AdminEvent[]>(`/api/admin/events?limit=${limit}`);
}

export async function pruneResults(): Promise<AdminMaintenanceResponse> {
  return adminFetch<AdminMaintenanceResponse>("/api/admin/results/prune", { method: "POST" });
}

export async function deleteResults(): Promise<AdminMaintenanceResponse> {
  return adminFetch<AdminMaintenanceResponse>("/api/admin/results", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE_RESULTS" })
  });
}

export async function resetActiveTests(): Promise<AdminMaintenanceResponse> {
  return adminFetch<AdminMaintenanceResponse>("/api/admin/active-tests/reset", { method: "POST" });
}

async function adminFetch<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...init,
    cache: "no-store",
    credentials: "include"
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new Error(body?.error ?? body?.message ?? `Request failed: ${response.status}`);
  }

  return (await response.json()) as T;
}
