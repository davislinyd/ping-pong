import crypto from "node:crypto";

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

type Session = {
  lastSeenAt: number;
};

export class ActiveTestTracker {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs = 15_000,
    private warningThreshold = 2,
    private maxActiveTests = 4
  ) {}

  start(now = Date.now()): ActiveTestSessionResponse | null {
    this.prune(now);
    if (this.sessions.size >= this.maxActiveTests) {
      return null;
    }

    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, { lastSeenAt: now });

    return {
      sessionId,
      ...this.snapshot(now)
    };
  }

  heartbeat(sessionId: string, now = Date.now()): ActiveTestsResponse | null {
    this.prune(now);
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.lastSeenAt = now;
    return this.snapshot(now);
  }

  finish(sessionId: string, now = Date.now()): ActiveTestsResponse {
    this.sessions.delete(sessionId);
    return this.snapshot(now);
  }

  current(now = Date.now()): ActiveTestsResponse {
    this.prune(now);
    return this.snapshot(now);
  }

  updateLimits(warningThreshold: number, maxActiveTests: number, now = Date.now()): ActiveTestsResponse {
    this.prune(now);
    this.warningThreshold = warningThreshold;
    this.maxActiveTests = maxActiveTests;
    return this.snapshot(now);
  }

  reset(now = Date.now()): { cleared: number; status: ActiveTestsResponse } {
    const cleared = this.sessions.size;
    this.sessions.clear();
    return {
      cleared,
      status: this.snapshot(now)
    };
  }

  private snapshot(now: number): ActiveTestsResponse {
    const activeTests = this.sessions.size;

    return {
      activeTests,
      warningThreshold: this.warningThreshold,
      maxActiveTests: this.maxActiveTests,
      isWarning: activeTests >= this.warningThreshold,
      isFull: activeTests >= this.maxActiveTests,
      updatedAt: new Date(now).toISOString()
    };
  }

  private prune(now: number): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastSeenAt > this.ttlMs) {
        this.sessions.delete(sessionId);
      }
    }
  }
}
