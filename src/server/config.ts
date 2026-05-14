import "dotenv/config";

import path from "node:path";
import { z } from "zod";

export const MAX_ALLOWED_TEST_BYTES = 1_073_741_824;

export type RuntimeConfig = {
  port: number;
  host: string;
  testServerName: string;
  sqlitePath: string;
  historyRetentionDays: number;
  defaultTestDurationSeconds: number;
  parallelConnections: number;
  maxTestBytes: number;
  trustProxy: boolean;
  allowLocalSelfTest: boolean;
  activeTestWarningThreshold: number;
  maxActiveTests: number;
  adminPassword: string | null;
  adminSessionTtlHours: number;
};

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  TEST_SERVER_NAME: z.string().min(1).default("Ping Pong Intranet"),
  SQLITE_PATH: z.string().min(1).default("./data/ping-pong.sqlite"),
  HISTORY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  DEFAULT_TEST_DURATION_SECONDS: z.coerce.number().int().min(3).max(60).default(15),
  PARALLEL_CONNECTIONS: z.coerce.number().int().min(1).max(16).default(4),
  MAX_TEST_BYTES: z.coerce.number().int().min(1_048_576).max(MAX_ALLOWED_TEST_BYTES).default(67_108_864),
  TRUST_PROXY: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((value) => ["true", "1", "yes"].includes(value)),
  ALLOW_LOCAL_SELF_TEST: z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((value) => ["true", "1", "yes"].includes(value)),
  ACTIVE_TEST_WARNING_THRESHOLD: z.coerce.number().int().min(1).max(100).default(2),
  MAX_ACTIVE_TESTS: z.coerce.number().int().min(1).max(100).default(4),
  ADMIN_PASSWORD: z.string().optional(),
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(8)
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = envSchema.parse(env);
  if (parsed.ACTIVE_TEST_WARNING_THRESHOLD > parsed.MAX_ACTIVE_TESTS) {
    throw new Error("ACTIVE_TEST_WARNING_THRESHOLD must be less than or equal to MAX_ACTIVE_TESTS");
  }

  return {
    port: parsed.PORT,
    host: parsed.HOST,
    testServerName: parsed.TEST_SERVER_NAME,
    sqlitePath: parsed.SQLITE_PATH === ":memory:" ? ":memory:" : path.resolve(process.cwd(), parsed.SQLITE_PATH),
    historyRetentionDays: parsed.HISTORY_RETENTION_DAYS,
    defaultTestDurationSeconds: parsed.DEFAULT_TEST_DURATION_SECONDS,
    parallelConnections: parsed.PARALLEL_CONNECTIONS,
    maxTestBytes: parsed.MAX_TEST_BYTES,
    trustProxy: parsed.TRUST_PROXY,
    allowLocalSelfTest: parsed.ALLOW_LOCAL_SELF_TEST,
    activeTestWarningThreshold: parsed.ACTIVE_TEST_WARNING_THRESHOLD,
    maxActiveTests: parsed.MAX_ACTIVE_TESTS,
    adminPassword: parsed.ADMIN_PASSWORD?.trim() ? parsed.ADMIN_PASSWORD.trim() : null,
    adminSessionTtlHours: parsed.ADMIN_SESSION_TTL_HOURS
  };
}
