import { describe, expect, it } from "vitest";

import { ActiveTestTracker } from "../src/server/active-tests";

describe("ActiveTestTracker", () => {
  it("expires sessions that stop sending heartbeats", () => {
    const tracker = new ActiveTestTracker(1000);
    const started = tracker.start(1000);

    expect(started?.activeTests).toBe(1);
    expect(tracker.current(1500).activeTests).toBe(1);
    expect(tracker.current(2501).activeTests).toBe(0);
  });

  it("keeps a session alive when heartbeat arrives before TTL", () => {
    const tracker = new ActiveTestTracker(1000);
    const started = tracker.start(1000);

    expect(started).not.toBeNull();
    expect(tracker.heartbeat(started!.sessionId, 1800)).toMatchObject({ activeTests: 1 });
    expect(tracker.current(2600).activeTests).toBe(1);
    expect(tracker.current(3001).activeTests).toBe(0);
  });

  it("reports warning and full states at configured thresholds", () => {
    const tracker = new ActiveTestTracker(1000, 2, 4);

    expect(tracker.start(1000)).toMatchObject({ activeTests: 1, isWarning: false, isFull: false });
    expect(tracker.start(1001)).toMatchObject({ activeTests: 2, isWarning: true, isFull: false });
    expect(tracker.start(1002)).toMatchObject({ activeTests: 3, isWarning: true, isFull: false });
    expect(tracker.start(1003)).toMatchObject({ activeTests: 4, isWarning: true, isFull: true });
    expect(tracker.start(1004)).toBeNull();
    expect(tracker.current(1004)).toMatchObject({
      activeTests: 4,
      warningThreshold: 2,
      maxActiveTests: 4,
      isWarning: true,
      isFull: true
    });
  });

  it("updates limits at runtime and blocks against the new max", () => {
    const tracker = new ActiveTestTracker(1000, 2, 4);

    expect(tracker.start(1000)).toMatchObject({ activeTests: 1, isWarning: false, isFull: false });
    expect(tracker.updateLimits(1, 1, 1001)).toMatchObject({
      activeTests: 1,
      warningThreshold: 1,
      maxActiveTests: 1,
      isWarning: true,
      isFull: true
    });
    expect(tracker.start(1002)).toBeNull();
  });

  it("resets active sessions", () => {
    const tracker = new ActiveTestTracker(1000, 2, 4);
    tracker.start(1000);
    tracker.start(1001);

    expect(tracker.reset(1002)).toMatchObject({
      cleared: 2,
      status: {
        activeTests: 0,
        isWarning: false,
        isFull: false
      }
    });
  });
});
