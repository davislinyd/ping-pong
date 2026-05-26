import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { DEFAULT_CAT_SPEED_RANGES } from "../src/shared/contracts";
import { createApp } from "../src/server/app";
import { browserClientHash } from "../src/server/client-identity";
import { loadConfig } from "../src/server/config";

describe("speed test API", () => {
  let app: FastifyInstance;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-pong-test-"));
    app = await createApp(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        TEST_SERVER_NAME: "Test Node",
        SQLITE_PATH: path.join(tmpDir, "test.sqlite"),
        HISTORY_RETENTION_DAYS: "30",
        DEFAULT_TEST_DURATION_SECONDS: "3",
        PARALLEL_CONNECTIONS: "2",
        MAX_TEST_BYTES: "1048576",
        TRUST_PROXY: "false",
        ALLOW_LOCAL_SELF_TEST: "true",
        ADMIN_PASSWORD: "secret",
        ADMIN_SESSION_TTL_HOURS: "8"
      })
    );
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns health and runtime config", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, serverName: "Test Node" });

    const config = await app.inject({ method: "GET", url: "/api/config" });
    expect(config.statusCode).toBe(200);
    expect(config.json()).toMatchObject({
      serverName: "Test Node",
      defaultTestDurationSeconds: 3,
      parallelConnections: 2,
      maxTestBytes: 1_048_576,
      catSpeedRanges: DEFAULT_CAT_SPEED_RANGES,
      clientSafety: {
        isLocalClient: true,
        canRunTest: true
      }
    });
  });

  it("returns no-store report context without exposing raw request headers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/report-context",
      headers: {
        cookie: "session=secret",
        authorization: "Bearer secret",
        "user-agent": "Mozilla/5.0 Chrome/120.0"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.json()).toMatchObject({
      serverName: "Test Node",
      clientIp: "127.0.0.1",
      coarseIp: "ipv4:127.0.0.0",
      ipSource: "direct-request-ip",
      trustProxyAware: false,
      browserFamily: "Chrome",
      clientSafety: {
        isLocalClient: true,
        canRunTest: true
      }
    });
    expect(response.json()).not.toHaveProperty("headers");
    expect(response.json()).not.toHaveProperty("cookie");
    expect(response.json()).not.toHaveProperty("authorization");
  });

  it("marks report context IP source as trusted proxy aware when configured", async () => {
    const proxyApp = await createApp(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        TEST_SERVER_NAME: "Proxy Test Node",
        SQLITE_PATH: ":memory:",
        HISTORY_RETENTION_DAYS: "30",
        DEFAULT_TEST_DURATION_SECONDS: "3",
        PARALLEL_CONNECTIONS: "2",
        MAX_TEST_BYTES: "1048576",
        TRUST_PROXY: "true",
        ALLOW_LOCAL_SELF_TEST: "true"
      })
    );

    try {
      const response = await proxyApp.inject({
        method: "GET",
        url: "/api/report-context",
        headers: {
          "x-forwarded-for": "10.20.30.40",
          "user-agent": "Mozilla/5.0 Firefox/120.0"
        }
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        clientIp: "10.20.30.40",
        coarseIp: "ipv4:10.20.30.0",
        ipSource: "trusted-proxy-request-ip",
        trustProxyAware: true,
        browserFamily: "Firefox"
      });
    } finally {
      await proxyApp.close();
    }
  });

  it("blocks local speed test endpoints by default", async () => {
    const blockedApp = await createApp(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        TEST_SERVER_NAME: "Blocked Test Node",
        SQLITE_PATH: ":memory:",
        HISTORY_RETENTION_DAYS: "30",
        DEFAULT_TEST_DURATION_SECONDS: "3",
        PARALLEL_CONNECTIONS: "2",
        MAX_TEST_BYTES: "1048576",
        TRUST_PROXY: "false"
      })
    );

    try {
      const config = await blockedApp.inject({ method: "GET", url: "/api/config" });
      expect(config.statusCode).toBe(200);
      expect(config.json()).toMatchObject({
        clientSafety: {
          isLocalClient: true,
          canRunTest: false
        }
      });

      const latency = await blockedApp.inject({ method: "GET", url: "/api/latency" });
      expect(latency.statusCode).toBe(403);
      expect(latency.json()).toMatchObject({
        error: "Local self-tests are disabled",
        clientSafety: {
          canRunTest: false
        }
      });

      const download = await blockedApp.inject({ method: "GET", url: "/api/download?bytes=1024" });
      expect(download.statusCode).toBe(403);

      const startSession = await blockedApp.inject({ method: "POST", url: "/api/active-tests" });
      expect(startSession.statusCode).toBe(403);
    } finally {
      await blockedApp.close();
    }
  });

  it("tracks active speed tests with heartbeat, finish, and stale pruning", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/active-tests" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      activeTests: 0,
      warningThreshold: 2,
      maxActiveTests: 4,
      isWarning: false,
      isFull: false
    });

    const started = await app.inject({ method: "POST", url: "/api/active-tests" });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ activeTests: 1, isWarning: false, isFull: false });
    expect(started.json().sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const heartbeat = await app.inject({ method: "POST", url: `/api/active-tests/${started.json().sessionId}/heartbeat` });
    expect(heartbeat.statusCode).toBe(200);
    expect(heartbeat.json()).toMatchObject({ activeTests: 1 });

    const finished = await app.inject({ method: "DELETE", url: `/api/active-tests/${started.json().sessionId}` });
    expect(finished.statusCode).toBe(200);
    expect(finished.json()).toMatchObject({ activeTests: 0 });

    const missingHeartbeat = await app.inject({ method: "POST", url: `/api/active-tests/${started.json().sessionId}/heartbeat` });
    expect(missingHeartbeat.statusCode).toBe(404);
  });

  it("warns at two active tests and rejects the fifth active test", async () => {
    const first = await app.inject({ method: "POST", url: "/api/active-tests" });
    const second = await app.inject({ method: "POST", url: "/api/active-tests" });
    const third = await app.inject({ method: "POST", url: "/api/active-tests" });
    const fourth = await app.inject({ method: "POST", url: "/api/active-tests" });
    const fifth = await app.inject({ method: "POST", url: "/api/active-tests" });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ activeTests: 1, isWarning: false, isFull: false });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ activeTests: 2, isWarning: true, isFull: false });
    expect(third.statusCode).toBe(201);
    expect(third.json()).toMatchObject({ activeTests: 3, isWarning: true, isFull: false });
    expect(fourth.statusCode).toBe(201);
    expect(fourth.json()).toMatchObject({ activeTests: 4, isWarning: true, isFull: true });
    expect(fifth.statusCode).toBe(429);
    expect(fifth.json()).toMatchObject({
      error: "Active test limit reached",
      activeTests: 4,
      warningThreshold: 2,
      maxActiveTests: 4,
      isWarning: true,
      isFull: true
    });
  });

  it("reports unconfigured admin auth and rejects admin writes", async () => {
    const unconfiguredApp = await createApp(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        TEST_SERVER_NAME: "No Admin",
        SQLITE_PATH: ":memory:",
        HISTORY_RETENTION_DAYS: "30",
        DEFAULT_TEST_DURATION_SECONDS: "3",
        PARALLEL_CONNECTIONS: "2",
        MAX_TEST_BYTES: "1048576",
        TRUST_PROXY: "false",
        ALLOW_LOCAL_SELF_TEST: "true"
      })
    );

    try {
      const session = await unconfiguredApp.inject({ method: "GET", url: "/api/admin/session" });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ configured: false, authenticated: false });

      const login = await unconfiguredApp.inject({
        method: "POST",
        url: "/api/admin/login",
        headers: { "content-type": "application/json" },
        payload: { password: "secret" }
      });
      expect(login.statusCode).toBe(503);

      const settings = await unconfiguredApp.inject({ method: "PATCH", url: "/api/admin/settings", payload: {} });
      expect(settings.statusCode).toBe(503);
    } finally {
      await unconfiguredApp.close();
    }
  });

  it("protects admin settings with password cookie login and logout", async () => {
    const protectedSettings = await app.inject({ method: "GET", url: "/api/admin/settings" });
    expect(protectedSettings.statusCode).toBe(401);

    const wrongLogin = await app.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "content-type": "application/json" },
      payload: { password: "wrong" }
    });
    expect(wrongLogin.statusCode).toBe(401);

    const cookie = await loginCookie(app);
    const settings = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie } });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({
      settings: {
        testServerName: "Test Node",
        requireAdminLoginOnLeave: false,
        maxActiveTests: 4
      },
      startup: {
        port: 8080,
        trustProxy: false
      }
    });

    const logout = await app.inject({ method: "POST", url: "/api/admin/logout", headers: { cookie } });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toMatchObject({ authenticated: false });

    const afterLogout = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie } });
    expect(afterLogout.statusCode).toBe(401);
  });

  it("applies admin settings to public config and active-test limits immediately", async () => {
    const cookie = await loginCookie(app);
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/admin/settings",
      headers: {
        "content-type": "application/json",
        cookie
      },
      payload: {
        testServerName: "Admin Node",
        defaultTestDurationSeconds: 5,
        parallelConnections: 3,
        maxTestBytes: 2_097_152,
        requireAdminLoginOnLeave: true,
        activeTestWarningThreshold: 1,
        maxActiveTests: 2,
        catSpeedRanges: {
          idle: { minMbps: 0, maxMbps: 2 },
          walk: { minMbps: 2, maxMbps: 75 },
          jog: { minMbps: 75, maxMbps: 250 },
          run: { minMbps: 250, maxMbps: 900 },
          sprint: { minMbps: 900, maxMbps: null }
        }
      }
    });

    expect(patched.statusCode).toBe(200);
    expect(patched.json()).toMatchObject({
      settings: {
        testServerName: "Admin Node",
        defaultTestDurationSeconds: 5,
        parallelConnections: 3,
        maxTestBytes: 2_097_152,
        requireAdminLoginOnLeave: true,
        activeTestWarningThreshold: 1,
        maxActiveTests: 2,
        catSpeedRanges: {
          idle: { minMbps: 0, maxMbps: 2 },
          walk: { minMbps: 2, maxMbps: 75 },
          jog: { minMbps: 75, maxMbps: 250 },
          run: { minMbps: 250, maxMbps: 900 },
          sprint: { minMbps: 900, maxMbps: null }
        }
      }
    });

    const publicConfig = await app.inject({ method: "GET", url: "/api/config" });
    expect(publicConfig.json()).toMatchObject({
      serverName: "Admin Node",
      defaultTestDurationSeconds: 5,
      parallelConnections: 3,
      maxTestBytes: 2_097_152,
      catSpeedRanges: {
        idle: { minMbps: 0, maxMbps: 2 },
        walk: { minMbps: 2, maxMbps: 75 },
        jog: { minMbps: 75, maxMbps: 250 },
        run: { minMbps: 250, maxMbps: 900 },
        sprint: { minMbps: 900, maxMbps: null }
      }
    });

    const first = await app.inject({ method: "POST", url: "/api/active-tests" });
    const second = await app.inject({ method: "POST", url: "/api/active-tests" });
    const third = await app.inject({ method: "POST", url: "/api/active-tests" });

    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ activeTests: 1, warningThreshold: 1, maxActiveTests: 2, isWarning: true, isFull: false });
    expect(second.statusCode).toBe(201);
    expect(second.json()).toMatchObject({ activeTests: 2, isWarning: true, isFull: true });
    expect(third.statusCode).toBe(429);
  });

  it("runs admin maintenance actions and records events", async () => {
    const cookie = await loginCookie(app);
    const payload = {
      downloadMbps: 120.5,
      uploadMbps: 82.4,
      downloadStats: {
        meanMbps: 120.5,
        p10Mbps: 110.2,
        p50Mbps: 120.5,
        p75Mbps: 126.5,
        p90Mbps: 132.9,
        rawCvPercent: 9.8,
        cvPercent: 5.4,
        sampleCount: 52,
        filteredSampleCount: 50
      },
      uploadStats: {
        meanMbps: 82.4,
        p10Mbps: 76.8,
        p50Mbps: 82.4,
        p75Mbps: 86.0,
        p90Mbps: 90.1,
        rawCvPercent: 8.6,
        cvPercent: 4.2,
        sampleCount: 51,
        filteredSampleCount: 50
      },
      idleLatencyMs: 4.8,
      downloadLoadedLatencyMs: 9.1,
      uploadLoadedLatencyMs: 11.2,
      jitterMs: 1.7,
      httpLossPercent: 0,
      durationSeconds: 3,
      parallelConnections: 2,
      networkLinkType: "wired"
    };

    await app.inject({
      method: "POST",
      url: "/api/results",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0 Chrome/120.0"
      },
      payload
    });
    await app.inject({ method: "POST", url: "/api/active-tests" });

    const statusBefore = await app.inject({ method: "GET", url: "/api/admin/status", headers: { cookie } });
    expect(statusBefore.statusCode).toBe(200);
    expect(statusBefore.json()).toMatchObject({
      activeTests: { activeTests: 1 },
      resultStats: { totalResults: 1 }
    });

    const reset = await app.inject({ method: "POST", url: "/api/admin/active-tests/reset", headers: { cookie } });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ ok: true, changed: 1 });

    const prune = await app.inject({ method: "POST", url: "/api/admin/results/prune", headers: { cookie } });
    expect(prune.statusCode).toBe(200);
    expect(prune.json()).toMatchObject({ ok: true, changed: 0 });

    const rejectedDelete = await app.inject({
      method: "DELETE",
      url: "/api/admin/results",
      headers: {
        "content-type": "application/json",
        cookie
      },
      payload: { confirm: "NO" }
    });
    expect(rejectedDelete.statusCode).toBe(400);

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/admin/results",
      headers: {
        "content-type": "application/json",
        cookie
      },
      payload: { confirm: "DELETE_RESULTS" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ ok: true, changed: 1 });

    const events = await app.inject({ method: "GET", url: "/api/admin/events", headers: { cookie } });
    expect(events.statusCode).toBe(200);
    expect(events.json().map((event: { action: string }) => event.action)).toEqual(
      expect.arrayContaining(["active_tests.reset", "results.pruned", "results.deleted"])
    );
  });

  it("streams the requested download byte count with no-store headers", async () => {
    const response = await app.inject({ method: "GET", url: "/api/download?bytes=4096" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toContain("no-store");
    expect(response.headers["content-length"]).toBe("4096");
    expect(response.rawPayload.byteLength).toBe(4096);
  });

  it("rejects oversized download requests", async () => {
    const response = await app.inject({ method: "GET", url: "/api/download?bytes=2097152" });

    expect(response.statusCode).toBe(400);
  });

  it("accepts upload bytes and reports the received count", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/upload",
      headers: {
        "content-type": "application/octet-stream"
      },
      payload: Buffer.alloc(2048)
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, receivedBytes: 2048 });
  });

  it("saves and returns anonymized recent results", async () => {
    const firstBrowserId = "11111111-1111-4111-8111-111111111111";
    const secondBrowserId = "22222222-2222-4222-8222-222222222222";
    const payload = {
      downloadMbps: 120.5,
      uploadMbps: 82.4,
      downloadStats: {
        meanMbps: 120.5,
        p10Mbps: 110.2,
        p50Mbps: 120.5,
        p75Mbps: 126.5,
        p90Mbps: 132.9,
        rawCvPercent: 9.8,
        cvPercent: 5.4,
        sampleCount: 52,
        filteredSampleCount: 50
      },
      uploadStats: {
        meanMbps: 82.4,
        p10Mbps: 76.8,
        p50Mbps: 82.4,
        p75Mbps: 86.0,
        p90Mbps: 90.1,
        rawCvPercent: 8.6,
        cvPercent: 4.2,
        sampleCount: 51,
        filteredSampleCount: 50
      },
      idleLatencyMs: 4.8,
      downloadLoadedLatencyMs: 9.1,
      uploadLoadedLatencyMs: 11.2,
      jitterMs: 1.7,
      httpLossPercent: 0,
      durationSeconds: 3,
      parallelConnections: 2,
      networkLinkType: "wifi"
    };

    const saved = await app.inject({
      method: "POST",
      url: "/api/results",
      headers: {
        "content-type": "application/json",
        "x-ping-pong-browser-id": firstBrowserId,
        "user-agent": "Mozilla/5.0 Chrome/120.0"
      },
      payload
    });

    expect(saved.statusCode).toBe(201);
    expect(saved.json()).toMatchObject({
      id: 1,
      serverName: "Test Node",
      browserFamily: "Chrome",
      downloadMbps: 120.5,
      clientIp: "127.0.0.1",
      downloadStats: {
        meanMbps: 120.5,
        p10Mbps: 110.2,
        p50Mbps: 120.5,
        p75Mbps: 126.5,
        p90Mbps: 132.9,
        rawCvPercent: 9.8,
        cvPercent: 5.4,
        sampleCount: 52,
        filteredSampleCount: 50
      },
      networkLinkType: "wifi",
      isLocalClient: true
    });
    expect(saved.json().downloadMbps).toBe(saved.json().downloadStats.meanMbps);
    expect(saved.json().uploadMbps).toBe(saved.json().uploadStats.meanMbps);
    expect(saved.json().clientId).toMatch(/^[a-f0-9]{20}$/);

    const recent = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10",
      headers: {
        "x-ping-pong-browser-id": firstBrowserId
      }
    });

    expect(recent.statusCode).toBe(200);
    expect(recent.json()).toHaveLength(0);

    const recentWithLocal = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10&includeLocal=true",
      headers: {
        "x-ping-pong-browser-id": firstBrowserId
      }
    });

    expect(recentWithLocal.statusCode).toBe(200);
    expect(recentWithLocal.json()).toHaveLength(1);
    expect(recentWithLocal.json()[0]).toMatchObject({
      downloadMbps: 120.5,
      uploadMbps: 82.4,
      browserFamily: "Chrome",
      clientIp: "127.0.0.1",
      isLocalClient: true,
      networkLinkType: "wifi",
      downloadStats: payload.downloadStats,
      uploadStats: {
        meanMbps: 82.4,
        p10Mbps: 76.8,
        p50Mbps: 82.4,
        p75Mbps: 86.0,
        p90Mbps: 90.1,
        rawCvPercent: 8.6,
        cvPercent: 4.2,
        sampleCount: 51,
        filteredSampleCount: 50
      }
    });
    expect(recentWithLocal.json()[0].downloadMbps).toBe(recentWithLocal.json()[0].downloadStats.meanMbps);
    expect(recentWithLocal.json()[0].uploadMbps).toBe(recentWithLocal.json()[0].uploadStats.meanMbps);

    await app.inject({
      method: "POST",
      url: "/api/results",
      headers: {
        "content-type": "application/json",
        "x-ping-pong-browser-id": secondBrowserId,
        "user-agent": "Mozilla/5.0 Firefox/120.0"
      },
      payload: {
        ...payload,
        downloadMbps: 95,
        uploadMbps: 44,
        downloadStats: { meanMbps: 95, p10Mbps: 90, p50Mbps: 95, p75Mbps: 97, p90Mbps: 100, rawCvPercent: 6, cvPercent: 3, sampleCount: 40, filteredSampleCount: 40 },
        uploadStats: { meanMbps: 44, p10Mbps: 40, p50Mbps: 44, p75Mbps: 46, p90Mbps: 48, rawCvPercent: 6, cvPercent: 3, sampleCount: 40, filteredSampleCount: 40 },
        networkLinkType: "wired"
      }
    });

    const firstBrowserRecent = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10&includeLocal=true",
      headers: {
        "x-ping-pong-browser-id": firstBrowserId
      }
    });
    const secondBrowserRecent = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10&includeLocal=true",
      headers: {
        "x-ping-pong-browser-id": secondBrowserId
      }
    });
    const missingBrowserRecent = await app.inject({ method: "GET", url: "/api/results/recent?limit=10&includeLocal=true" });
    const invalidBrowserRecent = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10&includeLocal=true",
      headers: {
        "x-ping-pong-browser-id": "not-a-browser-id"
      }
    });

    expect(firstBrowserRecent.json()).toHaveLength(1);
    expect(firstBrowserRecent.json()[0]).toMatchObject({ downloadMbps: 120.5, browserFamily: "Chrome", clientIp: "127.0.0.1", networkLinkType: "wifi" });
    expect(secondBrowserRecent.json()).toHaveLength(1);
    expect(secondBrowserRecent.json()[0]).toMatchObject({ downloadMbps: 95, browserFamily: "Firefox", clientIp: "127.0.0.1", networkLinkType: "wired" });
    expect(missingBrowserRecent.json()).toHaveLength(0);
    expect(invalidBrowserRecent.json()).toHaveLength(0);

    const missingBrowserDelete = await app.inject({ method: "DELETE", url: "/api/results" });
    const invalidBrowserDelete = await app.inject({
      method: "DELETE",
      url: "/api/results",
      headers: {
        "x-ping-pong-browser-id": "not-a-browser-id"
      }
    });
    const deletedFirstBrowser = await app.inject({
      method: "DELETE",
      url: "/api/results",
      headers: {
        "x-ping-pong-browser-id": firstBrowserId
      }
    });
    const firstBrowserAfterDelete = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10&includeLocal=true",
      headers: {
        "x-ping-pong-browser-id": firstBrowserId
      }
    });
    const secondBrowserAfterDelete = await app.inject({
      method: "GET",
      url: "/api/results/recent?limit=10&includeLocal=true",
      headers: {
        "x-ping-pong-browser-id": secondBrowserId
      }
    });

    expect(missingBrowserDelete.statusCode).toBe(400);
    expect(invalidBrowserDelete.statusCode).toBe(400);
    expect(deletedFirstBrowser.statusCode).toBe(200);
    expect(deletedFirstBrowser.json()).toMatchObject({ ok: true, changed: 1 });
    expect(firstBrowserAfterDelete.json()).toHaveLength(0);
    expect(secondBrowserAfterDelete.json()).toHaveLength(1);
    expect(secondBrowserAfterDelete.json()[0]).toMatchObject({ downloadMbps: 95, browserFamily: "Firefox", clientIp: "127.0.0.1", networkLinkType: "wired" });
  });

  it("saves the trusted proxy client IP with results", async () => {
    const proxyApp = await createApp(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        TEST_SERVER_NAME: "Proxy Test Node",
        SQLITE_PATH: ":memory:",
        HISTORY_RETENTION_DAYS: "30",
        DEFAULT_TEST_DURATION_SECONDS: "3",
        PARALLEL_CONNECTIONS: "2",
        MAX_TEST_BYTES: "1048576",
        TRUST_PROXY: "true",
        ALLOW_LOCAL_SELF_TEST: "true"
      })
    );

    try {
      const saved = await proxyApp.inject({
        method: "POST",
        url: "/api/results",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": "10.20.30.40",
          "x-ping-pong-browser-id": "33333333-3333-4333-8333-333333333333",
          "user-agent": "Mozilla/5.0 Firefox/120.0"
        },
        payload: {
          downloadMbps: 42,
          uploadMbps: 24,
          idleLatencyMs: 4.8,
          downloadLoadedLatencyMs: 9.1,
          uploadLoadedLatencyMs: 11.2,
          jitterMs: 1.7,
          httpLossPercent: 0,
          durationSeconds: 3,
          parallelConnections: 2,
          networkLinkType: "wired"
        }
      });

      const recent = await proxyApp.inject({
        method: "GET",
        url: "/api/results/recent?limit=10&includeLocal=true",
        headers: {
          "x-forwarded-for": "10.20.30.40",
          "x-ping-pong-browser-id": "33333333-3333-4333-8333-333333333333"
        }
      });

      expect(saved.statusCode).toBe(201);
      expect(saved.json()).toMatchObject({ clientIp: "10.20.30.40", browserFamily: "Firefox" });
      expect(recent.statusCode).toBe(200);
      expect(recent.json()[0]).toMatchObject({ clientIp: "10.20.30.40", browserFamily: "Firefox", networkLinkType: "wired" });
    } finally {
      await proxyApp.close();
    }
  });

  it("migrates legacy results without recorded client IP", async () => {
    const browserId = "44444444-4444-4444-8444-444444444444";
    const legacyPath = path.join(tmpDir, "legacy.sqlite");
    const db = new DatabaseSync(legacyPath);
    db.exec(`
      CREATE TABLE results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        server_name TEXT NOT NULL,
        download_mbps REAL NOT NULL,
        upload_mbps REAL NOT NULL,
        download_mean_mbps REAL NOT NULL DEFAULT 0,
        download_p10_mbps REAL NOT NULL,
        download_p50_mbps REAL NOT NULL,
        download_p75_mbps REAL NOT NULL DEFAULT 0,
        download_p90_mbps REAL NOT NULL,
        download_cv_percent REAL NOT NULL DEFAULT 0,
        download_sample_count INTEGER NOT NULL,
        download_filtered_sample_count INTEGER NOT NULL DEFAULT 0,
        upload_mean_mbps REAL NOT NULL DEFAULT 0,
        upload_p10_mbps REAL NOT NULL,
        upload_p50_mbps REAL NOT NULL,
        upload_p75_mbps REAL NOT NULL DEFAULT 0,
        upload_p90_mbps REAL NOT NULL,
        upload_cv_percent REAL NOT NULL DEFAULT 0,
        upload_sample_count INTEGER NOT NULL,
        upload_filtered_sample_count INTEGER NOT NULL DEFAULT 0,
        idle_latency_ms REAL NOT NULL,
        download_loaded_latency_ms REAL NOT NULL,
        upload_loaded_latency_ms REAL NOT NULL,
        jitter_ms REAL NOT NULL,
        http_loss_percent REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        parallel_connections INTEGER NOT NULL,
        network_link_type TEXT NOT NULL DEFAULT 'unknown',
        browser_family TEXT NOT NULL,
        client_id TEXT NOT NULL,
        browser_client_hash TEXT,
        is_local_client INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.prepare(`
      INSERT INTO results (
        created_at, server_name, download_mbps, upload_mbps,
        download_mean_mbps, download_p10_mbps, download_p50_mbps, download_p75_mbps, download_p90_mbps, download_cv_percent, download_sample_count, download_filtered_sample_count,
        upload_mean_mbps, upload_p10_mbps, upload_p50_mbps, upload_p75_mbps, upload_p90_mbps, upload_cv_percent, upload_sample_count, upload_filtered_sample_count,
        idle_latency_ms, download_loaded_latency_ms, upload_loaded_latency_ms, jitter_ms, http_loss_percent, duration_seconds, parallel_connections,
        network_link_type, browser_family, client_id, browser_client_hash, is_local_client
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "2026-05-20T08:00:00.000Z",
      "Legacy Node",
      120,
      80,
      120,
      110,
      120,
      125,
      130,
      5,
      10,
      10,
      80,
      76,
      80,
      84,
      88,
      4,
      10,
      10,
      5,
      8,
      10,
      1,
      0,
      3,
      2,
      "wifi",
      "Chrome",
      "legacy-client",
      browserClientHash(browserId),
      1
    );
    db.close();

    const legacyApp = await createApp(
      loadConfig({
        PORT: "8080",
        HOST: "127.0.0.1",
        TEST_SERVER_NAME: "Legacy Test Node",
        SQLITE_PATH: legacyPath,
        HISTORY_RETENTION_DAYS: "30",
        DEFAULT_TEST_DURATION_SECONDS: "3",
        PARALLEL_CONNECTIONS: "2",
        MAX_TEST_BYTES: "1048576",
        TRUST_PROXY: "false",
        ALLOW_LOCAL_SELF_TEST: "true"
      })
    );

    try {
      const recent = await legacyApp.inject({
        method: "GET",
        url: "/api/results/recent?limit=10&includeLocal=true",
        headers: {
          "x-ping-pong-browser-id": browserId
        }
      });

      expect(recent.statusCode).toBe(200);
      expect(recent.json()[0]).toMatchObject({
        serverName: "Legacy Node",
        clientIp: null,
        networkLinkType: "wifi",
        downloadStats: { cvPercent: 5, rawCvPercent: 5 },
        uploadStats: { cvPercent: 4, rawCvPercent: 4 }
      });
    } finally {
      await legacyApp.close();
    }
  });

  it("accepts legacy result payloads and derives single-value throughput stats", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/results",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        downloadMbps: 42,
        uploadMbps: 24,
        idleLatencyMs: 4.8,
        downloadLoadedLatencyMs: 9.1,
        uploadLoadedLatencyMs: 11.2,
        jitterMs: 1.7,
        httpLossPercent: 0,
        durationSeconds: 3,
        parallelConnections: 2
      }
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      downloadMbps: 42,
      uploadMbps: 24,
      networkLinkType: "unknown",
      downloadStats: { p10Mbps: 42, p50Mbps: 42, p90Mbps: 42, rawCvPercent: 0, sampleCount: 0 },
      uploadStats: { p10Mbps: 24, p50Mbps: 24, p90Mbps: 24, rawCvPercent: 0, sampleCount: 0 }
    });
  });

  it("validates result payloads", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/results",
      headers: {
        "content-type": "application/json"
      },
      payload: {
        downloadMbps: -1
      }
    });

    expect(response.statusCode).toBe(400);
  });
});

async function loginCookie(app: FastifyInstance): Promise<string> {
  const login = await app.inject({
    method: "POST",
    url: "/api/admin/login",
    headers: { "content-type": "application/json" },
    payload: { password: "secret" }
  });

  expect(login.statusCode).toBe(200);
  const setCookie = login.headers["set-cookie"];
  const rawCookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  expect(rawCookie).toBeTypeOf("string");
  return String(rawCookie).split(";")[0];
}
