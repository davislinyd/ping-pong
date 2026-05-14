import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cloneCatSpeedRanges, DEFAULT_CAT_SPEED_RANGES, type EditableRuntimeSettings } from "../src/shared/contracts";
import { ResultsRepository } from "../src/server/db";
import { RuntimeSettingsService } from "../src/server/settings";

const defaults: EditableRuntimeSettings = {
  testServerName: "Default Node",
  historyRetentionDays: 30,
  defaultTestDurationSeconds: 15,
  parallelConnections: 4,
  maxTestBytes: 67_108_864,
  allowLocalSelfTest: false,
  activeTestWarningThreshold: 2,
  maxActiveTests: 4,
  catSpeedRanges: cloneCatSpeedRanges(DEFAULT_CAT_SPEED_RANGES)
};

describe("RuntimeSettingsService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ping-pong-settings-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists SQLite settings and loads them over env defaults", () => {
    const sqlitePath = path.join(tmpDir, "settings.sqlite");
    const repository = new ResultsRepository(sqlitePath);
    const service = new RuntimeSettingsService(repository, defaults);

    expect(service.current()).toMatchObject({
      testServerName: "Default Node",
      maxActiveTests: 4,
      catSpeedRanges: DEFAULT_CAT_SPEED_RANGES
    });
    const updated = service.update({
      testServerName: "Admin Updated",
      maxActiveTests: 6,
      activeTestWarningThreshold: 3,
      allowLocalSelfTest: true,
      catSpeedRanges: {
        idle: { minMbps: 0, maxMbps: 1 },
        walk: { minMbps: 1, maxMbps: 25 },
        jog: { minMbps: 25, maxMbps: 125 },
        run: { minMbps: 125, maxMbps: 500 },
        sprint: { minMbps: 500, maxMbps: null }
      }
    });
    expect(updated.changedKeys.sort()).toEqual(["activeTestWarningThreshold", "allowLocalSelfTest", "catSpeedRanges", "maxActiveTests", "testServerName"]);
    repository.close();

    const reopenedRepository = new ResultsRepository(sqlitePath);
    const reopenedService = new RuntimeSettingsService(reopenedRepository, {
      ...defaults,
      testServerName: "Changed Env Default",
      maxActiveTests: 2
    });

    expect(reopenedService.current()).toMatchObject({
      testServerName: "Admin Updated",
      maxActiveTests: 6,
      activeTestWarningThreshold: 3,
      allowLocalSelfTest: true,
      catSpeedRanges: {
        idle: { minMbps: 0, maxMbps: 1 },
        walk: { minMbps: 1, maxMbps: 25 },
        jog: { minMbps: 25, maxMbps: 125 },
        run: { minMbps: 125, maxMbps: 500 },
        sprint: { minMbps: 500, maxMbps: null }
      }
    });
    reopenedRepository.close();
  });

  it("rejects invalid threshold combinations", () => {
    const repository = new ResultsRepository(":memory:");
    const service = new RuntimeSettingsService(repository, defaults);

    expect(() => service.update({ activeTestWarningThreshold: 5, maxActiveTests: 4 })).toThrow(
      /activeTestWarningThreshold must be less than or equal to maxActiveTests/
    );
    repository.close();
  });

  it("rejects invalid cat speed ranges", () => {
    const repository = new ResultsRepository(":memory:");
    const service = new RuntimeSettingsService(repository, defaults);

    expect(() =>
      service.update({
        catSpeedRanges: {
          idle: { minMbps: 0, maxMbps: 0 },
          walk: { minMbps: 10, maxMbps: 50 },
          jog: { minMbps: 50, maxMbps: 200 },
          run: { minMbps: 200, maxMbps: 800 },
          sprint: { minMbps: 800, maxMbps: null }
        }
      })
    ).toThrow(/walk\.minMbps must match the previous maxMbps/);

    expect(() =>
      service.update({
        catSpeedRanges: {
          idle: { minMbps: 0, maxMbps: 0 },
          walk: { minMbps: 0, maxMbps: -1 },
          jog: { minMbps: -1, maxMbps: 200 },
          run: { minMbps: 200, maxMbps: 800 },
          sprint: { minMbps: 800, maxMbps: null }
        }
      })
    ).toThrow();

    expect(() =>
      service.update({
        catSpeedRanges: {
          idle: { minMbps: 0, maxMbps: 0 },
          walk: { minMbps: 0, maxMbps: 50 },
          jog: { minMbps: 25, maxMbps: 200 },
          run: { minMbps: 200, maxMbps: 800 },
          sprint: { minMbps: 800, maxMbps: null }
        }
      })
    ).toThrow(/jog\.minMbps must match the previous maxMbps/);

    repository.close();
  });

  it("migrates legacy result rows to throughput summary stats", () => {
    const sqlitePath = path.join(tmpDir, "legacy-results.sqlite");
    const db = new DatabaseSync(sqlitePath);
    db.exec(`
      CREATE TABLE results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        server_name TEXT NOT NULL,
        download_mbps REAL NOT NULL,
        upload_mbps REAL NOT NULL,
        idle_latency_ms REAL NOT NULL,
        download_loaded_latency_ms REAL NOT NULL,
        upload_loaded_latency_ms REAL NOT NULL,
        jitter_ms REAL NOT NULL,
        http_loss_percent REAL NOT NULL,
        duration_seconds INTEGER NOT NULL,
        parallel_connections INTEGER NOT NULL,
        browser_family TEXT NOT NULL,
        client_id TEXT NOT NULL,
        is_local_client INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO results (
        created_at,
        server_name,
        download_mbps,
        upload_mbps,
        idle_latency_ms,
        download_loaded_latency_ms,
        upload_loaded_latency_ms,
        jitter_ms,
        http_loss_percent,
        duration_seconds,
        parallel_connections,
        browser_family,
        client_id,
        is_local_client
      )
      VALUES (
        '2026-05-13T00:00:00.000Z',
        'Legacy Node',
        120.5,
        82.4,
        4.8,
        9.1,
        11.2,
        1.7,
        0,
        8,
        4,
        'Chrome',
        'abcdef1234567890abcd',
        0
      );
    `);
    db.close();

    const repository = new ResultsRepository(sqlitePath);
    expect(repository.recent(10, true, null)).toHaveLength(0);
    expect(repository.recent(10, true, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toHaveLength(0);
    repository.close();

    const migratedDb = new DatabaseSync(sqlitePath);
    const legacy = migratedDb
      .prepare(
        `
        SELECT
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
          browser_client_hash AS browserClientHash
        FROM results
        WHERE id = 1
      `
      )
      .get() as {
      downloadMbps: number;
      uploadMbps: number;
      downloadP10Mbps: number;
      downloadP50Mbps: number;
      downloadP90Mbps: number;
      downloadSampleCount: number;
      uploadP10Mbps: number;
      uploadP50Mbps: number;
      uploadP90Mbps: number;
      uploadSampleCount: number;
      browserClientHash: string | null;
    };

    expect(legacy).toMatchObject({
      downloadMbps: 120.5,
      uploadMbps: 82.4,
      downloadP10Mbps: 120.5,
      downloadP50Mbps: 120.5,
      downloadP90Mbps: 120.5,
      downloadSampleCount: 0,
      uploadP10Mbps: 82.4,
      uploadP50Mbps: 82.4,
      uploadP90Mbps: 82.4,
      uploadSampleCount: 0,
      browserClientHash: null
    });
    migratedDb.close();
  });
});
