import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { ZodError } from "zod";

import { BROWSER_CLIENT_ID_HEADER, type EditableRuntimeSettings } from "../shared/contracts.js";
import { AdminSessionManager } from "./admin-auth.js";
import { MAX_ALLOWED_TEST_BYTES, type RuntimeConfig } from "./config.js";
import { ActiveTestTracker } from "./active-tests.js";
import { anonymousClientId, browserClientHash, browserFamily, coarseIp } from "./client-identity.js";
import { ResultsRepository } from "./db.js";
import { createDownloadStream } from "./download-stream.js";
import { detectLocalClient } from "./local-client.js";
import { editableDefaultsFromConfig, RuntimeSettingsService, startupSettingsFromConfig } from "./settings.js";
import { adminLoginSchema, deleteResultsSchema, downloadQuerySchema, recentQuerySchema, resultPayloadSchema } from "./validation.js";

export async function createApp(config: RuntimeConfig): Promise<FastifyInstance> {
  const repository = new ResultsRepository(config.sqlitePath);
  const runtimeSettings = new RuntimeSettingsService(repository, editableDefaultsFromConfig(config));
  const initialSettings = runtimeSettings.current();
  const startupSettings = startupSettingsFromConfig(config);
  const activeTests = new ActiveTestTracker(15_000, initialSettings.activeTestWarningThreshold, initialSettings.maxActiveTests);
  const adminSessions = new AdminSessionManager(config.adminPassword, config.adminSessionTtlHours);
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
    return {
      serverName: settings.testServerName,
      defaultTestDurationSeconds: settings.defaultTestDurationSeconds,
      parallelConnections: settings.parallelConnections,
      maxTestBytes: settings.maxTestBytes,
      catSpeedRanges: settings.catSpeedRanges,
      clientSafety: clientSafetyForRequest(settings, request.ip)
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

  app.post("/api/active-tests", async (request, reply) => {
    const blocked = blockedLocalTest(runtimeSettings.current(), request.ip);
    if (blocked) {
      return reply.code(403).send(blocked);
    }

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

  app.post("/api/active-tests/:sessionId/heartbeat", async (request, reply) => {
    const blocked = blockedLocalTest(runtimeSettings.current(), request.ip);
    if (blocked) {
      return reply.code(403).send(blocked);
    }

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

  app.get("/api/latency", async (request, reply) => {
    const blocked = blockedLocalTest(runtimeSettings.current(), request.ip);
    if (blocked) {
      return reply.code(403).send(blocked);
    }

    reply.headers(noStoreHeaders());
    return {
      ok: true,
      serverTime: Date.now()
    };
  });

  app.get("/api/download", async (request, reply) => {
    const settings = runtimeSettings.current();
    const blocked = blockedLocalTest(settings, request.ip);
    if (blocked) {
      return reply.code(403).send(blocked);
    }

    const parsed = downloadQuerySchema(settings.maxTestBytes).safeParse(request.query);
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

  app.post("/api/upload", async (request, reply) => {
    const settings = runtimeSettings.current();
    const blocked = blockedLocalTest(settings, request.ip);
    if (blocked) {
      return reply.code(403).send(blocked);
    }

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

  app.post("/api/results", async (request, reply) => {
    const settings = runtimeSettings.current();
    const blocked = blockedLocalTest(settings, request.ip);
    if (blocked) {
      return reply.code(403).send(blocked);
    }

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

  app.get("/api/admin/settings", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

    reply.headers(noStoreHeaders());
    return {
      settings: runtimeSettings.current(),
      startup: startupSettings
    };
  });

  app.patch("/api/admin/settings", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

    try {
      const updated = runtimeSettings.update(request.body);
      activeTests.updateLimits(updated.settings.activeTestWarningThreshold, updated.settings.maxActiveTests);
      if (updated.changedKeys.length > 0) {
        repository.recordAdminEvent("settings.updated", { changedKeys: updated.changedKeys });
      }

      reply.headers(noStoreHeaders());
      return {
        settings: updated.settings,
        startup: startupSettings
      };
    } catch (error) {
      if (error instanceof ZodError) {
        return reply.code(400).send({
          error: "Invalid admin settings payload",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        });
      }
      throw error;
    }
  });

  app.get("/api/admin/status", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

    reply.headers(noStoreHeaders());
    return {
      activeTests: activeTests.current(),
      resultStats: repository.resultStats(),
      startup: startupSettings
    };
  });

  app.get("/api/admin/events", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

    reply.headers(noStoreHeaders());
    return repository.recentAdminEvents(adminLimit(request.query));
  });

  app.post("/api/admin/results/prune", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

    const changed = repository.prune(runtimeSettings.current().historyRetentionDays);
    repository.recordAdminEvent("results.pruned", { changed });
    reply.headers(noStoreHeaders());
    return { ok: true, changed };
  });

  app.delete("/api/admin/results", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

    const parsed = deleteResultsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Delete results requires confirm: "DELETE_RESULTS"' });
    }

    const changed = repository.clearResults();
    repository.recordAdminEvent("results.deleted", { changed });
    reply.headers(noStoreHeaders());
    return { ok: true, changed };
  });

  app.post("/api/admin/active-tests/reset", async (request, reply) => {
    if (!ensureAdmin(adminSessions, request, reply)) return;

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

function blockedLocalTest(config: Pick<EditableRuntimeSettings, "allowLocalSelfTest">, clientIp: string) {
  const clientSafety = clientSafetyForRequest(config, clientIp);
  if (clientSafety.canRunTest) {
    return null;
  }

  return {
    error: "Local self-tests are disabled",
    clientSafety
  };
}

function ensureAdmin(auth: AdminSessionManager, request: FastifyRequest, reply: FastifyReply): boolean {
  if (!auth.isConfigured()) {
    void reply.code(503).send({ error: "Admin password is not configured" });
    return false;
  }

  const session = auth.sessionFromCookie(request.headers.cookie);
  if (!session.authenticated) {
    void reply.code(401).send({ error: "Admin login required" });
    return false;
  }

  return true;
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
