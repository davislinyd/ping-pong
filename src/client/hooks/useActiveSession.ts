import { useEffect, useRef, useState } from "react";

import { type ActiveTestsResponse, type ActiveTestSessionResponse } from "../../shared/contracts";
import {
  finishActiveTestSession,
  heartbeatActiveTestSession,
  loadActiveTests,
  startActiveTestSession
} from "../speed-test";

const emptyActiveStatus: ActiveTestsResponse = {
  activeTests: 0,
  warningThreshold: 2,
  maxActiveTests: 4,
  isWarning: false,
  isFull: false,
  updatedAt: ""
};

export type ActiveSessionHook = {
  activeStatus: ActiveTestsResponse;
  beginSession: () => Promise<ActiveTestSessionResponse>;
  closeSession: (sessionId: string) => Promise<void>;
};

export function useActiveSession(): ActiveSessionHook {
  const [activeStatus, setActiveStatus] = useState<ActiveTestsResponse>(emptyActiveStatus);
  const activeSessionRef = useRef<string | null>(null);
  const heartbeatTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        setActiveStatus(await loadActiveTests());
      } catch {
        // Active count is informational; avoid disrupting the speed-test workflow.
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    return () => {
      stopHeartbeat();
      if (activeSessionRef.current) {
        void finishActiveTestSession(activeSessionRef.current).catch(() => undefined);
      }
    };
  }, []);

  function stopHeartbeat() {
    if (heartbeatTimerRef.current !== null) {
      window.clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    }
  }

  function startHeartbeat(sessionId: string) {
    stopHeartbeat();
    heartbeatTimerRef.current = window.setInterval(() => {
      void heartbeatActiveTestSession(sessionId)
        .then((next) => setActiveStatus(next))
        .catch(() => undefined);
    }, 3000);
  }

  async function beginSession(): Promise<ActiveTestSessionResponse> {
    const session = await startActiveTestSession();
    activeSessionRef.current = session.sessionId;
    setActiveStatus(session);
    startHeartbeat(session.sessionId);
    return session;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const isActive = activeSessionRef.current === sessionId;
    if (isActive) {
      stopHeartbeat();
      activeSessionRef.current = null;
    }

    try {
      const next = await finishActiveTestSession(sessionId);
      if (isActive) setActiveStatus(next);
    } catch {
      if (isActive) {
        try {
          setActiveStatus(await loadActiveTests());
        } catch {
          // ignore — status will refresh on next poll
        }
      }
    }
  }

  return { activeStatus, beginSession, closeSession };
}
