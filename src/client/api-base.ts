export const API_BASE = import.meta.env.VITE_API_BASE ?? "";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: Record<string, unknown> | null,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, { ...init, cache: "no-store" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    throw new ApiError(response.status, body, (body?.error as string | undefined) ?? `Request failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function postJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return fetchJson<T>(url, { ...init, method: "POST" });
}

export async function deleteJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  return fetchJson<T>(url, { ...init, method: "DELETE" });
}
