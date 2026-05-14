import { cloneCatSpeedRanges, DEFAULT_CAT_SPEED_RANGES, type EditableRuntimeSettings, type StartupSettings } from "../shared/contracts.js";
import type { RuntimeConfig } from "./config.js";
import type { ResultsRepository } from "./db.js";
import { editableRuntimeSettingsPatchSchema, editableRuntimeSettingsSchema } from "./validation.js";

export class RuntimeSettingsService {
  private currentSettings: EditableRuntimeSettings;

  constructor(
    private readonly repository: ResultsRepository,
    defaults: EditableRuntimeSettings
  ) {
    this.currentSettings = editableRuntimeSettingsSchema.parse({
      ...defaults,
      ...repository.loadSettings()
    });
  }

  current(): EditableRuntimeSettings {
    return cloneEditableRuntimeSettings(this.currentSettings);
  }

  update(patch: unknown): { settings: EditableRuntimeSettings; changedKeys: string[] } {
    const parsedPatch = editableRuntimeSettingsPatchSchema.parse(patch);
    const nextSettings = editableRuntimeSettingsSchema.parse({
      ...this.currentSettings,
      ...parsedPatch
    });
    const changedKeys = Object.entries(nextSettings)
      .filter(([key, value]) => !sameSettingValue(this.currentSettings[key as keyof EditableRuntimeSettings], value))
      .map(([key]) => key);

    this.repository.saveSettings(nextSettings);
    this.currentSettings = nextSettings;

    return {
      settings: this.current(),
      changedKeys
    };
  }
}

export function editableDefaultsFromConfig(config: RuntimeConfig): EditableRuntimeSettings {
  return {
    testServerName: config.testServerName,
    historyRetentionDays: config.historyRetentionDays,
    defaultTestDurationSeconds: config.defaultTestDurationSeconds,
    parallelConnections: config.parallelConnections,
    maxTestBytes: config.maxTestBytes,
    allowLocalSelfTest: config.allowLocalSelfTest,
    requireAdminLoginOnLeave: false,
    activeTestWarningThreshold: config.activeTestWarningThreshold,
    maxActiveTests: config.maxActiveTests,
    catSpeedRanges: cloneCatSpeedRanges(DEFAULT_CAT_SPEED_RANGES)
  };
}

export function startupSettingsFromConfig(config: RuntimeConfig): StartupSettings {
  return {
    port: config.port,
    host: config.host,
    sqlitePath: config.sqlitePath,
    trustProxy: config.trustProxy
  };
}

function cloneEditableRuntimeSettings(settings: EditableRuntimeSettings): EditableRuntimeSettings {
  return {
    ...settings,
    catSpeedRanges: cloneCatSpeedRanges(settings.catSpeedRanges)
  };
}

function sameSettingValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
