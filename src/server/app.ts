import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";

import { BROWSER_CLIENT_ID_HEADER, DEFAULT_LOCAL_THROTTLE, type ClientSafety, type EditableRuntimeSettings } from "../shared/contracts.js";
import { AdminSessionManager } from "./admin-auth.js";
import { MAX_ALLOWED_TEST_BYTES, type RuntimeConfig } from "./config.js";
import { ActiveTestTracker } from "./active-tests.js";
import { anonymousClientId, browserClientHash, browserFamily, coarseIp } from "./client-identity.js";
import { ResultsRepository } from "./db.js";
import { createDownloadStream } from "./download-stream.js";
import { detectLocalClient } from "./local-client.js";
import { editableDefaultsFromConfig, RuntimeSettingsService, startupSettingsFromConfig } from "./settings.js";
import { adminLoginSchema, createDownloadQuerySchema, deleteResultsSchema, recentQuerySchema, resultPayloadSchema } from "./validation.js";
import { requireAdmin } from "./middleware/admin-auth-hook.js";
import { requireTestAccess } from "./middleware/test-access-hook.js";

export async function createApp(config: RuntimeConfig): Promise<FastifyInstance> {
  const repository = new ResultsRepository(config.sqlitePath);
  const runtimeSettings = new RuntimeSettingsService(repository, editableDefaultsFromConfig(config));
  const initialSettings = runtimeSettings.current();
  const startupSettings = startupSettingsFromConfig(config);
  const activeTests = new ActiveTestTracker(15_000, initialSettings.activeTestWarningThreshold, initialSettings.maxActiveTests);
  const adminSessions = new AdminSessionManager(config.adminPassword, config.adminSessionTtlHours);
  let downloadSchema = createDownloadQuerySchema(initialSettings.maxTestBytes);
  const testAccessHook = { preHandler: requireTestAccess(runtimeSettings) };
  const adminHook = { preHandler: requireAdmin(adminSessions) };
  repository.prune(initialSettings.historyRetentionDays);

  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : true,
    disableRequestLogging: true,
    trustProxy: config.trustProxy,
    bodyLimit: MAX_ALLOWED_TEST_BYTES + 1024
  });

  app.addHook("onClose", async () => {
    repository.close();
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        details: error.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
      });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_ALLOWED_TEST_BYTES },
    (_request, body, done) => {
      done(null, body);
    }
  );

  if (process.env.NODE_ENV === "development") {
    await app.register(cors, { origin: true, credentials: true });
  }

  app.get("/api/health", async () => ({
    ok: true,
    serverName: runtimeSettings.current().testServerName,
    time: new Date().toISOString()
  }));

  app.get("/api/config", async (request) => {
    const settings = runtimeSettings.current();
    const clientSafety = clientSafetyForRequest(settings, request.ip);
    return {
      serverName: settings.testServerName,
      defaultTestDurationSeconds: settings.defaultTestDurationSeconds,
      parallelConnections: settings.parallelConnections,
      maxTestBytes: settings.maxTestBytes,
      catSpeedRanges: settings.catSpeedRanges,
      clientSafety,
      localThrottle: localThrottleForClientSafety(clientSafety)
    };
  });

  app.get("/api/report-context", async (request, reply) => {
    const settings = runtimeSettings.current();
    reply.headers(noStoreHeaders());
    return {
      serverTime: new Date().toISOString(),
      serverName: settings.testServerName,
      requestHost: request.hostname,
      requestProtocol: request.protocol,
      clientIp: request.ip,
      coarseIp: coarseIp(request.ip),
      ipSource: config.trustProxy ? "trusted-proxy-request-ip" : "direct-request-ip",
      trustProxyAware: config.trustProxy,
      browserFamily: browserFamily(firstHeader(request.headers["user-agent"])),
      clientSafety: clientSafetyForRequest(settings, request.ip)
    };
  });

  app.get("/api/active-tests", async (_request, reply) => {
    reply.headers(noStoreHeaders());
    return activeTests.current();
  });

  app.post("/api/active-tests", testAccessHook, async (_request, reply) => {
    reply.headers(noStoreHeaders());
    const started = activeTests.start();
    if (!started) {
      return reply.code(429).send({
        error: "Active test limit reached",
        message: "Too many users are running speed tests right now. Try again after another test finishes.",
        ...activeTests.current()
      });
    }

    return reply.code(201).send(started);
  });

  app.post("/api/active-tests/:sessionId/heartbeat", testAccessHook, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const result = activeTests.heartbeat(sessionId);
    if (!result) {
      return reply.code(404).send({ error: "Unknown active test session" });
    }

    reply.headers(noStoreHeaders());
    return result;
  });

  app.delete("/api/active-tests/:sessionId", async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    reply.headers(noStoreHeaders());
    return activeTests.finish(sessionId);
  });

  app.get("/api/latency", testAccessHook, async (_request, reply) => {
    reply.headers(noStoreHeaders());
    return {
      ok: true,
      serverTime: Date.now()
    };
  });

  app.get("/api/download", testAccessHook, async (request, reply) => {
    const parsed = downloadSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid download size" });
    }

    const bytes = parsed.data.bytes;
    reply.headers({
      ...noStoreHeaders(),
      "content-type": "application/octet-stream",
      "content-length": String(bytes),
      "x-accel-buffering": "no"
    });

    return reply.send(createDownloadStream(bytes));
  });

  app.post("/api/upload", testAccessHook, async (request, reply) => {
    const settings = runtimeSettings.current();
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(415).send({ error: "Expected application/octet-stream body" });
    }
    if (body.byteLength > settings.maxTestBytes) {
      return reply.code(413).send({ error: "Upload size exceeds maxTestBytes" });
    }

    reply.headers(noStoreHeaders());
    return {
      ok: true,
      receivedBytes: body.byteLength
    };
  });

  app.post("/api/results", testAccessHook, async (request, reply) => {
    const settings = runtimeSettings.current();
    const parsed = resultPayloadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid result payload" });
    }

    const identity = anonymousClientId({
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      serverName: settings.testServerName
    });
    const saved = repository.save(parsed.data, {
      serverName: settings.testServerName,
      isLocalClient: detectLocalClient(request.ip).isLocalClient,
      clientIp: request.ip,
      browserClientHash: browserClientHash(request.headers[BROWSER_CLIENT_ID_HEADER.toLowerCase()]),
      ...identity
    });
    repository.prune(settings.historyRetentionDays);

    return reply.code(201).send(saved);
  });

  app.get("/api/results/recent", async (request, reply) => {
    const parsed = recentQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid recent results query" });
    }

    reply.headers(noStoreHeaders());
    return repository.recent(parsed.data.limit, parsed.data.includeLocal, browserClientHash(request.headers[BROWSER_CLIENT_ID_HEADER.toLowerCase()]));
  });

  app.delete("/api/results", async (request, reply) => {
    const currentBrowserClientHash = browserClientHash(request.headers[BROWSER_CLIENT_ID_HEADER.toLowerCase()]);
    if (!currentBrowserClientHash) {
      return reply.code(400).send({ error: `Delete results requires valid ${BROWSER_CLIENT_ID_HEADER}` });
    }

    reply.headers(noStoreHeaders());
    const changed = repository.clearResultsForBrowser(currentBrowserClientHash);
    return { ok: true, changed };
  });

  app.get("/api/admin/session", async (request, reply) => {
    reply.headers(noStoreHeaders());
    const session = adminSessions.sessionFromCookie(request.headers.cookie);
    return {
      configured: adminSessions.isConfigured(),
      authenticated: session.authenticated,
      expiresAt: session.expiresAt,
      sessionTtlHours: adminSessions.sessionTtlHours
    };
  });

  app.post("/api/admin/login", async (request, reply) => {
    if (!adminSessions.isConfigured()) {
      return reply.code(503).send({ error: "Admin password is not configured" });
    }

    const parsed = adminLoginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid admin login payload" });
    }

    const login = adminSessions.login(parsed.data.password);
    if (!login) {
      return reply.code(401).send({ error: "Invalid admin password" });
    }

    reply.headers({
      ...noStoreHeaders(),
      "set-cookie": login.cookie
    });
    return {
      configured: true,
      authenticated: true,
      expiresAt: login.expiresAt,
      sessionTtlHours: adminSessions.sessionTtlHours
    };
  });

  app.post("/api/admin/logout", async (request, reply) => {
    adminSessions.logout(request.headers.cookie);
    reply.headers({
      ...noStoreHeaders(),
      "set-cookie": adminSessions.clearCookie()
    });
    return {
      configured: adminSessions.isConfigured(),
      authenticated: false,
      expiresAt: null,
      sessionTtlHours: adminSessions.sessionTtlHours
    };
  });

  app.get("/api/admin/settings", adminHook, async (_request, reply) => {
    reply.headers(noStoreHeaders());
    return {
      settings: runtimeSettings.current(),
      startup: startupSettings
    };
  });

  app.patch("/api/admin/settings", adminHook, async (request, reply) => {
    const updated = runtimeSettings.update(request.body);
    activeTests.updateLimits(updated.settings.activeTestWarningThreshold, updated.settings.maxActiveTests);
    downloadSchema = createDownloadQuerySchema(updated.settings.maxTestBytes);
    if (updated.changedKeys.length > 0) {
      repository.recordAdminEvent("settings.updated", { changedKeys: updated.changedKeys });
    }

    reply.headers(noStoreHeaders());
    return {
      settings: updated.settings,
      startup: startupSettings
    };
  });

  app.get("/api/admin/status", adminHook, async (_request, reply) => {
    reply.headers(noStoreHeaders());
    return {
      activeTests: activeTests.current(),
      resultStats: repository.resultStats(),
      startup: startupSettings
    };
  });

  app.get("/api/admin/events", adminHook, async (request, reply) => {
    reply.headers(noStoreHeaders());
    return repository.recentAdminEvents(adminLimit(request.query));
  });

  app.post("/api/admin/results/prune", adminHook, async (_request, reply) => {
    const changed = repository.prune(runtimeSettings.current().historyRetentionDays);
    repository.recordAdminEvent("results.pruned", { changed });
    reply.headers(noStoreHeaders());
    return { ok: true, changed };
  });

  app.delete("/api/admin/results", adminHook, async (request, reply) => {
    const parsed = deleteResultsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Delete results requires confirm: "DELETE_RESULTS"' });
    }

    const changed = repository.clearResults();
    repository.recordAdminEvent("results.deleted", { changed });
    reply.headers(noStoreHeaders());
    return { ok: true, changed };
  });

  app.post("/api/admin/active-tests/reset", adminHook, async (_request, reply) => {
    const reset = activeTests.reset();
    repository.recordAdminEvent("active_tests.reset", { changed: reset.cleared });
    reply.headers(noStoreHeaders());
    return { ok: true, changed: reset.cleared };
  });

  await registerStaticClient(app);

  return app;
}

function noStoreHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    pragma: "no-cache",
    expires: "0",
    "surrogate-control": "no-store",
    "x-content-type-options": "nosniff"
  };
}

function clientSafetyForRequest(config: Pick<EditableRuntimeSettings, "allowLocalSelfTest">, clientIp: string) {
  const safety = detectLocalClient(clientIp);
  const canRunTest = config.allowLocalSelfTest || !safety.isLocalClient;

  return {
    ...safety,
    canRunTest,
    message:
      safety.isLocalClient && !canRunTest
        ? `${safety.message} Testing is disabled on this machine.`
        : safety.message
  };
}

function localThrottleForClientSafety(clientSafety: ClientSafety) {
  return {
    ...DEFAULT_LOCAL_THROTTLE,
    active: clientSafety.isLocalClient && clientSafety.canRunTest
  };
}

function adminLimit(query: unknown): number {
  const rawLimit = typeof query === "object" && query !== null && "limit" in query ? Number((query as { limit?: unknown }).limit) : 50;
  if (!Number.isFinite(rawLimit)) {
    return 50;
  }
  return Math.max(1, Math.min(100, Math.trunc(rawLimit)));
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function registerStaticClient(app: FastifyInstance): Promise<void> {
  const clientRoot = path.resolve(process.cwd(), "dist/client");
  if (!fs.existsSync(clientRoot)) {
    return;
  }

  await app.register(fastifyStatic, {
    root: clientRoot,
    prefix: "/"
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }

    return reply.sendFile("index.html");
  });
}
