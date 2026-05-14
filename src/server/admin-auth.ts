import crypto from "node:crypto";

export type AdminAuthState = {
  authenticated: boolean;
  expiresAt: string | null;
};

type AdminSession = {
  expiresAtMs: number;
};

const adminCookieName = "ping_pong_admin";

export class AdminSessionManager {
  private readonly sessions = new Map<string, AdminSession>();
  private readonly ttlMs: number;

  constructor(
    private readonly password: string | null,
    readonly sessionTtlHours: number
  ) {
    this.ttlMs = sessionTtlHours * 60 * 60 * 1000;
  }

  isConfigured(): boolean {
    return Boolean(this.password);
  }

  login(password: string, now = Date.now()): { sessionId: string; expiresAt: string; cookie: string } | null {
    if (!this.password || !safeEqual(password, this.password)) {
      return null;
    }

    this.prune(now);
    const sessionId = crypto.randomUUID();
    const expiresAtMs = now + this.ttlMs;
    this.sessions.set(sessionId, { expiresAtMs });

    return {
      sessionId,
      expiresAt: new Date(expiresAtMs).toISOString(),
      cookie: sessionCookie(sessionId, expiresAtMs, this.ttlMs)
    };
  }

  sessionFromCookie(cookieHeader: string | string[] | undefined, now = Date.now()): AdminAuthState {
    this.prune(now);
    const sessionId = adminSessionIdFromCookie(cookieHeader);
    if (!sessionId) {
      return { authenticated: false, expiresAt: null };
    }

    const session = this.sessions.get(sessionId);
    if (!session || session.expiresAtMs <= now) {
      this.sessions.delete(sessionId);
      return { authenticated: false, expiresAt: null };
    }

    return {
      authenticated: true,
      expiresAt: new Date(session.expiresAtMs).toISOString()
    };
  }

  logout(cookieHeader: string | string[] | undefined): void {
    const sessionId = adminSessionIdFromCookie(cookieHeader);
    if (sessionId) {
      this.sessions.delete(sessionId);
    }
  }

  clearCookie(): string {
    return `${adminCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  private prune(now: number): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(sessionId);
      }
    }
  }
}

function sessionCookie(sessionId: string, expiresAtMs: number, ttlMs: number): string {
  const maxAge = Math.max(0, Math.floor(ttlMs / 1000));
  return [
    `${adminCookieName}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
    `Expires=${new Date(expiresAtMs).toUTCString()}`
  ].join("; ");
}

function adminSessionIdFromCookie(cookieHeader: string | string[] | undefined): string | null {
  const header = Array.isArray(cookieHeader) ? cookieHeader.join("; ") : cookieHeader;
  if (!header) {
    return null;
  }

  for (const part of header.split(";")) {
    const [rawName, ...rawValueParts] = part.trim().split("=");
    if (rawName === adminCookieName) {
      return decodeURIComponent(rawValueParts.join("="));
    }
  }

  return null;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
