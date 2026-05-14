import { z } from "zod";

import { catSpeedRangeValidationMessage } from "../shared/contracts.js";
import { MAX_ALLOWED_TEST_BYTES } from "./config.js";

const throughputStatsSchema = z
  .object({
    p10Mbps: z.number().finite().min(0).max(1_000_000),
    p50Mbps: z.number().finite().min(0).max(1_000_000),
    p90Mbps: z.number().finite().min(0).max(1_000_000),
    sampleCount: z.number().int().min(0).max(100_000)
  })
  .strict();

export const resultPayloadSchema = z
  .object({
    downloadMbps: z.number().finite().min(0).max(1_000_000),
    uploadMbps: z.number().finite().min(0).max(1_000_000),
    downloadStats: throughputStatsSchema.optional(),
    uploadStats: throughputStatsSchema.optional(),
    idleLatencyMs: z.number().finite().min(0).max(600_000),
    downloadLoadedLatencyMs: z.number().finite().min(0).max(600_000),
    uploadLoadedLatencyMs: z.number().finite().min(0).max(600_000),
    jitterMs: z.number().finite().min(0).max(600_000),
    httpLossPercent: z.number().finite().min(0).max(100),
    durationSeconds: z.number().int().min(1).max(3600),
    parallelConnections: z.number().int().min(1).max(64)
  })
  .transform((payload) => {
    const downloadStats = payload.downloadStats ?? legacyThroughputStats(payload.downloadMbps);
    const uploadStats = payload.uploadStats ?? legacyThroughputStats(payload.uploadMbps);

    return {
      ...payload,
      downloadMbps: downloadStats.p50Mbps,
      uploadMbps: uploadStats.p50Mbps,
      downloadStats,
      uploadStats
    };
  });

export const recentQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  includeLocal: z
    .preprocess((value) => value ?? "false", z.enum(["true", "false", "1", "0", "yes", "no"]))
    .transform((value) => ["true", "1", "yes"].includes(value))
});

export const downloadQuerySchema = (maxBytes: number) =>
  z.object({
    bytes: z.coerce.number().int().min(1).max(maxBytes).default(Math.min(maxBytes, 16_777_216))
  });

const editableRuntimeSettingsBaseSchema = z
  .object({
    testServerName: z.string().trim().min(1).max(80),
    historyRetentionDays: z.number().int().min(1).max(3650),
    defaultTestDurationSeconds: z.number().int().min(3).max(60),
    parallelConnections: z.number().int().min(1).max(16),
    maxTestBytes: z.number().int().min(1_048_576).max(MAX_ALLOWED_TEST_BYTES),
    allowLocalSelfTest: z.boolean(),
    activeTestWarningThreshold: z.number().int().min(1).max(100),
    maxActiveTests: z.number().int().min(1).max(100),
    catSpeedRanges: z
      .object({
        idle: speedRangeSchema(),
        walk: speedRangeSchema(),
        jog: speedRangeSchema(),
        run: speedRangeSchema(),
        sprint: speedRangeSchema()
      })
      .strict()
  })
  .strict();

export const editableRuntimeSettingsSchema = editableRuntimeSettingsBaseSchema.superRefine((settings, context) => {
  if (settings.activeTestWarningThreshold > settings.maxActiveTests) {
    context.addIssue({
      code: "custom",
      path: ["activeTestWarningThreshold"],
      message: "activeTestWarningThreshold must be less than or equal to maxActiveTests"
    });
  }

  const catRangeError = catSpeedRangeValidationMessage(settings.catSpeedRanges);
  if (catRangeError) {
    context.addIssue({
      code: "custom",
      path: ["catSpeedRanges"],
      message: catRangeError
    });
  }
});

export const editableRuntimeSettingsPatchSchema = editableRuntimeSettingsBaseSchema.partial().strict();

export const adminLoginSchema = z
  .object({
    password: z.string().min(1)
  })
  .strict();

export const deleteResultsSchema = z
  .object({
    confirm: z.literal("DELETE_RESULTS")
  })
  .strict();

function speedRangeSchema() {
  return z
    .object({
      minMbps: z.number().finite().min(0).max(1_000_000),
      maxMbps: z.number().finite().min(0).max(1_000_000).nullable()
    })
    .strict();
}

function legacyThroughputStats(mbps: number) {
  return {
    p10Mbps: mbps,
    p50Mbps: mbps,
    p90Mbps: mbps,
    sampleCount: 0
  };
}
