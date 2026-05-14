import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import type { AdminEvent, EditableRuntimeSettings, ResultPayload, ResultStats, SavedResult } from "../shared/contracts.js";

type SaveContext = {
  serverName: string;
  browserFamily: string;
  clientId: string;
  browserClientHash: string | null;
  isLocalClient: boolean;
};

const settingKeys = [
  "testServerName",
  "historyRetentionDays",
  "defaultTestDurationSeconds",
  "parallelConnections",
  "maxTestBytes",
  "allowLocalSelfTest",
  "requireAdminLoginOnLeave",
  "activeTestWarningThreshold",
  "maxActiveTests",
  "catSpeedRanges"
] as const;

type SettingKey = (typeof settingKeys)[number];

export class ResultsRepository {
  private readonly db: DatabaseSync;

  constructor(sqlitePath: string) {
    if (sqlitePath !== ":memory:") {
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    }

    this.db = new DatabaseSync(sqlitePath);
    this.initialize();
  }

  save(payload: ResultPayload, context: SaveContext): SavedResult {
    const createdAt = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO results (
        created_at,
        server_name,
        download_mbps,
        upload_mbps,
        download_p10_mbps,
        download_p50_mbps,
        download_p90_mbps,
        download_sample_count,
        upload_p10_mbps,
        upload_p50_mbps,
        upload_p90_mbps,
        upload_sample_count,
        idle_latency_ms,
        download_loaded_latency_ms,
        upload_loaded_latency_ms,
        jitter_ms,
        http_loss_percent,
        duration_seconds,
        parallel_connections,
        browser_family,
        client_id,
        browser_client_hash,
        is_local_client
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = statement.run(
      createdAt,
      context.serverName,
      payload.downloadMbps,
      payload.uploadMbps,
      payload.downloadStats.p10Mbps,
      payload.downloadStats.p50Mbps,
      payload.downloadStats.p90Mbps,
      payload.downloadStats.sampleCount,
      payload.uploadStats.p10Mbps,
      payload.uploadStats.p50Mbps,
      payload.uploadStats.p90Mbps,
      payload.uploadStats.sampleCount,
      payload.idleLatencyMs,
      payload.downloadLoadedLatencyMs,
      payload.uploadLoadedLatencyMs,
      payload.jitterMs,
      payload.httpLossPercent,
      payload.durationSeconds,
      payload.parallelConnections,
      context.browserFamily,
      context.clientId,
      context.browserClientHash,
      context.isLocalClient ? 1 : 0
    );

    return {
      id: Number(result.lastInsertRowid),
      createdAt,
      serverName: context.serverName,
      browserFamily: context.browserFamily,
      clientId: context.clientId,
      isLocalClient: context.isLocalClient,
      ...payload
    };
  }

  recent(limit: number, includeLocal: boolean, browserClientHash: string | null): SavedResult[] {
    if (!browserClientHash) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          created_at AS createdAt,
          server_name AS serverName,
          download_mbps AS downloadMbps,
          upload_mbps AS uploadMbps,
          download_p10_mbps AS downloadP10Mbps,
          download_p50_mbps AS downloadP50Mbps,
          download_p90_mbps AS downloadP90Mbps,
          download_sample_count AS downloadSampleCount,
          upload_p10_mbps AS uploadP10Mbps,
          upload_p50_mbps AS uploadP50Mbps,
          upload_p90_mbps AS uploadP90Mbps,
          upload_sample_count AS uploadSampleCount,
          idle_latency_ms AS idleLatencyMs,
          download_loaded_latency_ms AS downloadLoadedLatencyMs,
          upload_loaded_latency_ms AS uploadLoadedLatencyMs,
          jitter_ms AS jitterMs,
          http_loss_percent AS httpLossPercent,
          duration_seconds AS durationSeconds,
          parallel_connections AS parallelConnections,
          browser_family AS browserFamily,
          client_id AS clientId,
          is_local_client AS isLocalClient
        FROM results
        WHERE browser_client_hash = ? AND (? = 1 OR is_local_client = 0)
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(browserClientHash, includeLocal ? 1 : 0, limit);

    return rows.map(rowToSavedResult);
  }

  prune(retentionDays: number): number {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const result = this.db.prepare("DELETE FROM results WHERE created_at < ?").run(cutoff);
    return Number(result.changes);
  }

  clearResults(): number {
    const result = this.db.prepare("DELETE FROM results").run();
    return Number(result.changes);
  }

  clearResultsForBrowser(browserClientHash: string): number {
    const result = this.db.prepare("DELETE FROM results WHERE browser_client_hash = ?").run(browserClientHash);
    return Number(result.changes);
  }

  resultStats(): ResultStats {
    const row = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS totalResults,
          SUM(CASE WHEN is_local_client = 1 THEN 1 ELSE 0 END) AS localResults,
          MIN(created_at) AS oldestResultAt,
          MAX(created_at) AS newestResultAt
        FROM results
      `
      )
      .get() as {
      totalResults: number;
      localResults: number | null;
      oldestResultAt: string | null;
      newestResultAt: string | null;
    };

    return {
      totalResults: Number(row.totalResults),
      localResults: Number(row.localResults ?? 0),
      oldestResultAt: row.oldestResultAt,
      newestResultAt: row.newestResultAt
    };
  }

  loadSettings(): Partial<EditableRuntimeSettings> {
    const rows = this.db.prepare("SELECT key, value FROM app_settings").all() as Array<{ key: string; value: string }>;
    const settings: Partial<EditableRuntimeSettings> = {};

    for (const row of rows) {
      if (!isSettingKey(row.key)) {
        continue;
      }
      (settings as Record<string, unknown>)[row.key] = JSON.parse(row.value);
    }

    return settings;
  }

  saveSettings(settings: EditableRuntimeSettings): void {
    const updatedAt = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of settingKeys) {
        statement.run(key, JSON.stringify(settings[key]), updatedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  recordAdminEvent(action: string, metadata: Record<string, unknown> = {}): AdminEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO admin_events (created_at, action, metadata_json) VALUES (?, ?, ?)")
      .run(createdAt, action, JSON.stringify(metadata));

    return {
      id: Number(result.lastInsertRowid),
      createdAt,
      action,
      metadata
    };
  }

  recentAdminEvents(limit = 50): AdminEvent[] {
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          created_at AS createdAt,
          action,
          metadata_json AS metadataJson
        FROM admin_events
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(limit) as Array<{ id: number; createdAt: string; action: string; metadataJson: string }>;

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.createdAt,
      action: row.action,
      metadata: parseMetadata(row.metadataJson)
    }));
  }

  close(): void {
    this.db.close();
  }

  private initialize(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        server_name TEXT NOT NULL,
        download_mbps REAL NOT NULL,
        upload_mbps REAL NOT NULL,
        download_p10_mbps REAL NOT NULL,
        download_p50_mbps REAL NOT NULL,
        download_p90_mbps REAL NOT NULL,
        download_sample_count INTEGER NOT NULL,
        upload_p10_mbps REAL NOT NULL,
        upload_p50_mbps REAL NOT NULL,
        upload_p90_mbps REAL NOT NULL,
        upload_sample_count INTEGER NOT NULL,
        idle_latency_ms REAL NOT NULL,
        download_loaded_latency_ms REAL NOT NULL,
        upload_loaded_latency_ms REAL NOT NULL,
        jitter_ms REAL NOT NULL,
        http_loss_percent REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        parallel_connections INTEGER NOT NULL,
        browser_family TEXT NOT NULL,
        client_id TEXT NOT NULL,
        browser_client_hash TEXT,
        is_local_client INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_results_client_id ON results(client_id);

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS admin_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        action TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_admin_events_created_at ON admin_events(created_at DESC);
    `);
    this.migrate();
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_results_browser_client_hash_created_at ON results(browser_client_hash, created_at DESC)");
  }

  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(results)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "is_local_client")) {
      this.db.exec("ALTER TABLE results ADD COLUMN is_local_client INTEGER NOT NULL DEFAULT 0");
    }
    let addedStatsColumn = false;
    addedStatsColumn = this.addResultColumn(columns, "download_p10_mbps", "download_p10_mbps REAL NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "download_p50_mbps", "download_p50_mbps REAL NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "download_p90_mbps", "download_p90_mbps REAL NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "download_sample_count", "download_sample_count INTEGER NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "upload_p10_mbps", "upload_p10_mbps REAL NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "upload_p50_mbps", "upload_p50_mbps REAL NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "upload_p90_mbps", "upload_p90_mbps REAL NOT NULL DEFAULT 0") || addedStatsColumn;
    addedStatsColumn = this.addResultColumn(columns, "upload_sample_count", "upload_sample_count INTEGER NOT NULL DEFAULT 0") || addedStatsColumn;
    this.addResultColumn(columns, "browser_client_hash", "browser_client_hash TEXT");

    if (addedStatsColumn) {
      this.db.exec(`
        UPDATE results
        SET
          download_p10_mbps = download_mbps,
          download_p50_mbps = download_mbps,
          download_p90_mbps = download_mbps,
          upload_p10_mbps = upload_mbps,
          upload_p50_mbps = upload_mbps,
          upload_p90_mbps = upload_mbps
        WHERE download_sample_count = 0 AND upload_sample_count = 0
      `);
    }
  }

  private addResultColumn(columns: Array<{ name: string }>, name: string, definition: string): boolean {
    if (columns.some((column) => column.name === name)) {
      return false;
    }

    this.db.exec(`ALTER TABLE results ADD COLUMN ${definition}`);
    columns.push({ name });
    return true;
  }
}

type ResultRow = Omit<SavedResult, "isLocalClient" | "downloadStats" | "uploadStats"> & {
  isLocalClient: number;
  downloadP10Mbps: number;
  downloadP50Mbps: number;
  downloadP90Mbps: number;
  downloadSampleCount: number;
  uploadP10Mbps: number;
  uploadP50Mbps: number;
  uploadP90Mbps: number;
  uploadSampleCount: number;
};

function rowToSavedResult(row: unknown): SavedResult {
  const result = row as ResultRow;
  return {
    id: result.id,
    createdAt: result.createdAt,
    serverName: result.serverName,
    browserFamily: result.browserFamily,
    clientId: result.clientId,
    isLocalClient: Boolean(result.isLocalClient),
    downloadMbps: result.downloadMbps,
    uploadMbps: result.uploadMbps,
    downloadStats: {
      p10Mbps: result.downloadP10Mbps,
      p50Mbps: result.downloadP50Mbps,
      p90Mbps: result.downloadP90Mbps,
      sampleCount: result.downloadSampleCount
    },
    uploadStats: {
      p10Mbps: result.uploadP10Mbps,
      p50Mbps: result.uploadP50Mbps,
      p90Mbps: result.uploadP90Mbps,
      sampleCount: result.uploadSampleCount
    },
    idleLatencyMs: result.idleLatencyMs,
    downloadLoadedLatencyMs: result.downloadLoadedLatencyMs,
    uploadLoadedLatencyMs: result.uploadLoadedLatencyMs,
    jitterMs: result.jitterMs,
    httpLossPercent: result.httpLossPercent,
    durationSeconds: result.durationSeconds,
    parallelConnections: result.parallelConnections
  };
}

function isSettingKey(value: string): value is SettingKey {
  return (settingKeys as readonly string[]).includes(value);
}

function parseMetadata(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return {};
}
