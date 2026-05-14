import {
  Activity,
  ArrowLeft,
  Database,
  Loader2,
  LogOut,
  RotateCw,
  Save,
  Server,
  Settings,
  ShieldCheck,
  Trash2,
  UsersRound
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";

import {
  CAT_SPEED_STAGES,
  catSpeedRangeValidationMessage,
  normalizeCatSpeedRanges,
  type AdminEvent,
  type AdminSessionResponse,
  type AdminSettingsResponse,
  type AdminStatusResponse,
  type CatSpeedRange,
  type CatSpeedRanges,
  type CatSpeedStage,
  type EditableRuntimeSettings
} from "../shared/contracts";
import {
  deleteResults,
  loadAdminEvents,
  loadAdminSession,
  loadAdminSettings,
  loadAdminStatus,
  loginAdmin,
  logoutAdmin,
  pruneResults,
  resetActiveTests,
  saveAdminSettings
} from "./admin-api";

type BusyState = "login" | "save" | "refresh" | "prune" | "delete" | "reset" | "logout" | null;

const catSpeedStageLabels: Record<CatSpeedStage, string> = {
  idle: "Idle",
  walk: "Walk",
  jog: "Jog",
  run: "Run",
  sprint: "Sprint"
};

export function AdminConsole() {
  const [session, setSession] = useState<AdminSessionResponse | null>(null);
  const [settingsResponse, setSettingsResponse] = useState<AdminSettingsResponse | null>(null);
  const [statusResponse, setStatusResponse] = useState<AdminStatusResponse | null>(null);
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [draft, setDraft] = useState<EditableRuntimeSettings | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<BusyState>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const thresholdInvalid = draft ? draft.activeTestWarningThreshold > draft.maxActiveTests : false;
  const rangeValidationMessage = draft ? catSpeedRangeValidationMessage(draft.catSpeedRanges) : null;
  const settingsInvalid = thresholdInvalid || rangeValidationMessage !== null;
  const maxTestMb = draft ? Math.round(draft.maxTestBytes / 1_048_576) : 0;

  const statusTiles = useMemo(
    () => [
      {
        label: "Active Tests",
        value: statusResponse ? `${statusResponse.activeTests.activeTests}/${statusResponse.activeTests.maxActiveTests}` : "-",
        icon: UsersRound
      },
      {
        label: "Saved Results",
        value: String(statusResponse?.resultStats.totalResults ?? "-"),
        icon: Database
      },
      {
        label: "Local Results",
        value: String(statusResponse?.resultStats.localResults ?? "-"),
        icon: Activity
      },
      {
        label: "Host",
        value: statusResponse?.startup.host ?? "-",
        icon: Server
      }
    ],
    [statusResponse]
  );

  useEffect(() => {
    void loadAdminSession()
      .then((nextSession) => {
        setSession(nextSession);
        if (nextSession.authenticated) {
          void refreshAdminData();
        }
      })
      .catch((loadError) => setError(messageFromError(loadError)));
  }, []);

  useEffect(() => {
    if (!session?.authenticated || !settingsResponse?.settings.requireAdminLoginOnLeave) return;

    let logoutSent = false;
    function logoutOnLeave() {
      if (logoutSent) return;
      logoutSent = true;
      sendLeaveLogout();
    }

    window.addEventListener("pagehide", logoutOnLeave);
    return () => window.removeEventListener("pagehide", logoutOnLeave);
  }, [session?.authenticated, settingsResponse?.settings.requireAdminLoginOnLeave]);

  useEffect(() => {
    if (!session?.authenticated) return;

    function verifyRestoredSession(event: PageTransitionEvent) {
      if (!event.persisted) return;

      void loadAdminSession()
        .then((nextSession) => {
          setSession(nextSession);
          if (!nextSession.authenticated) {
            clearAdminData();
          }
        })
        .catch((loadError) => setError(messageFromError(loadError)));
    }

    window.addEventListener("pageshow", verifyRestoredSession);
    return () => window.removeEventListener("pageshow", verifyRestoredSession);
  }, [session?.authenticated]);

  async function refreshAdminData() {
    setBusy("refresh");
    setError(null);
    try {
      const [nextSettings, nextStatus, nextEvents] = await Promise.all([loadAdminSettings(), loadAdminStatus(), loadAdminEvents()]);
      const normalizedSettings = {
        ...nextSettings,
        settings: {
          ...nextSettings.settings,
          catSpeedRanges: normalizeCatSpeedRanges(nextSettings.settings.catSpeedRanges)
        }
      };
      setSettingsResponse(normalizedSettings);
      setDraft(normalizedSettings.settings);
      setStatusResponse(nextStatus);
      setEvents(nextEvents);
    } catch (loadError) {
      setError(messageFromError(loadError));
    } finally {
      setBusy(null);
    }
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy("login");
    setError(null);
    setNotice(null);
    try {
      const nextSession = await loginAdmin(password);
      setSession(nextSession);
      setPassword("");
      await refreshAdminData();
    } catch (loginError) {
      setError(messageFromError(loginError));
    } finally {
      setBusy(null);
    }
  }

  async function handleLogout() {
    setBusy("logout");
    setError(null);
    try {
      const nextSession = await logoutAdmin();
      setSession(nextSession);
      clearAdminData();
      setNotice(null);
    } catch (logoutError) {
      setError(messageFromError(logoutError));
    } finally {
      setBusy(null);
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || settingsInvalid) return;

    setBusy("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await saveAdminSettings(draft);
      setSettingsResponse(saved);
      setDraft(saved.settings);
      setNotice("Settings saved");
      await refreshAdminData();
    } catch (saveError) {
      setError(messageFromError(saveError));
    } finally {
      setBusy(null);
    }
  }

  async function runMaintenance(action: BusyState, task: () => Promise<unknown>, success: string) {
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await task();
      setNotice(success);
      await refreshAdminData();
    } catch (maintenanceError) {
      setError(messageFromError(maintenanceError));
    } finally {
      setBusy(null);
    }
  }

  function updateDraft<K extends keyof EditableRuntimeSettings>(key: K, value: EditableRuntimeSettings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  function clearAdminData() {
    setSettingsResponse(null);
    setStatusResponse(null);
    setDraft(null);
    setEvents([]);
  }

  function updateCatSpeedRange(stage: CatSpeedStage, key: keyof CatSpeedRange, value: number | null) {
    setDraft((current) =>
      current
        ? {
            ...current,
            catSpeedRanges: {
              ...current.catSpeedRanges,
              [stage]: {
                ...current.catSpeedRanges[stage],
                [key]: value
              }
            }
          }
        : current
    );
  }

  if (!session) {
    return (
      <main className="admin-shell">
        <AdminHeader authenticated={false} onLogout={() => undefined} />
        <section className="admin-panel admin-centered">
          <Loader2 className="spin" size={24} />
          <span>Loading admin console</span>
        </section>
      </main>
    );
  }

  if (!session.configured) {
    return (
      <main className="admin-shell">
        <AdminHeader authenticated={false} onLogout={() => undefined} />
        <section className="admin-panel admin-centered">
          <ShieldCheck size={28} />
          <h2>Admin password is not configured</h2>
          <p>Set ADMIN_PASSWORD in .env and restart the Node.js service.</p>
        </section>
      </main>
    );
  }

  if (!session.authenticated) {
    return (
      <main className="admin-shell">
        <AdminHeader authenticated={false} onLogout={() => undefined} />
        <form className="admin-login admin-panel" onSubmit={(event) => void handleLogin(event)}>
          <ShieldCheck size={28} />
          <h2>Admin Login</h2>
          <label>
            <span>Password</span>
            <input value={password} type="password" autoComplete="current-password" onChange={(event) => setPassword(event.target.value)} />
          </label>
          {error ? <p className="admin-error">{error}</p> : null}
          <button className="primary-action admin-action" type="submit" disabled={busy === "login" || password.length === 0}>
            {busy === "login" ? <Loader2 className="spin" size={18} /> : <ShieldCheck size={18} />}
            <span>Login</span>
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="admin-shell">
      <AdminHeader authenticated={true} onLogout={() => void handleLogout()} />

      <section className="admin-status-grid" aria-label="Admin status">
        {statusTiles.map((tile) => (
          <article className="admin-stat" key={tile.label}>
            <tile.icon size={20} />
            <span>{tile.label}</span>
            <strong>{tile.value}</strong>
          </article>
        ))}
      </section>

      {error ? <section className="admin-alert is-error">{error}</section> : null}
      {notice ? <section className="admin-alert is-success">{notice}</section> : null}

      <section className="admin-layout">
        <form className="admin-panel admin-settings" onSubmit={(event) => void handleSave(event)}>
          <div className="admin-panel-heading">
            <div>
              <p className="eyebrow">Runtime</p>
              <h2>Speed Test Settings</h2>
            </div>
            <button className="admin-icon-button" type="button" onClick={() => void refreshAdminData()} title="Refresh" aria-label="Refresh">
              <RotateCw size={18} />
            </button>
          </div>

          {draft ? (
            <>
              <label className="admin-field full">
                <span>Server name</span>
                <input value={draft.testServerName} onChange={(event) => updateDraft("testServerName", event.target.value)} />
              </label>

              <div className="admin-field-grid">
                <NumberField
                  label="Test duration"
                  suffix="seconds"
                  value={draft.defaultTestDurationSeconds}
                  min={3}
                  max={60}
                  onChange={(value) => updateDraft("defaultTestDurationSeconds", value)}
                />
                <NumberField
                  label="Parallel connections"
                  value={draft.parallelConnections}
                  min={1}
                  max={16}
                  onChange={(value) => updateDraft("parallelConnections", value)}
                />
                <NumberField label="Max payload" suffix="MB" value={maxTestMb} min={1} max={1024} onChange={(value) => updateDraft("maxTestBytes", value * 1_048_576)} />
                <NumberField
                  label="History retention"
                  suffix="days"
                  value={draft.historyRetentionDays}
                  min={1}
                  max={3650}
                  onChange={(value) => updateDraft("historyRetentionDays", value)}
                />
                <NumberField
                  label="Warning threshold"
                  value={draft.activeTestWarningThreshold}
                  min={1}
                  max={100}
                  onChange={(value) => updateDraft("activeTestWarningThreshold", value)}
                />
                <NumberField label="Max active tests" value={draft.maxActiveTests} min={1} max={100} onChange={(value) => updateDraft("maxActiveTests", value)} />
              </div>

              <CatSpeedRangeEditor ranges={draft.catSpeedRanges} onChange={updateCatSpeedRange} />

              <label className="admin-toggle">
                <input checked={draft.allowLocalSelfTest} type="checkbox" onChange={(event) => updateDraft("allowLocalSelfTest", event.target.checked)} />
                <span>Allow local self-test</span>
              </label>

              <label className="admin-toggle">
                <input
                  checked={draft.requireAdminLoginOnLeave}
                  type="checkbox"
                  onChange={(event) => updateDraft("requireAdminLoginOnLeave", event.target.checked)}
                />
                <span>Require password after leaving admin console</span>
              </label>

              {thresholdInvalid ? <p className="admin-error">Warning threshold must be less than or equal to max active tests.</p> : null}
              {rangeValidationMessage ? <p className="admin-error">{rangeValidationMessage}</p> : null}

              <div className="admin-form-footer">
                <span>{settingsResponse ? `SQLite settings loaded for ${settingsResponse.settings.testServerName}` : "Settings loading"}</span>
                <button className="primary-action admin-action" type="submit" disabled={busy === "save" || settingsInvalid}>
                  {busy === "save" ? <Loader2 className="spin" size={18} /> : <Save size={18} />}
                  <span>Save</span>
                </button>
              </div>
            </>
          ) : (
            <div className="admin-loading">
              <Loader2 className="spin" size={22} />
              <span>Loading settings</span>
            </div>
          )}
        </form>

        <aside className="admin-side">
          <section className="admin-panel">
            <div className="admin-panel-heading">
              <div>
                <p className="eyebrow">Startup</p>
                <h2>Service Settings</h2>
              </div>
            </div>
            <dl className="admin-kv">
              <div>
                <dt>Port</dt>
                <dd>{settingsResponse?.startup.port ?? "-"}</dd>
              </div>
              <div>
                <dt>Host</dt>
                <dd>{settingsResponse?.startup.host ?? "-"}</dd>
              </div>
              <div>
                <dt>Trust proxy</dt>
                <dd>{settingsResponse?.startup.trustProxy ? "Enabled" : "Disabled"}</dd>
              </div>
              <div>
                <dt>SQLite</dt>
                <dd>{settingsResponse?.startup.sqlitePath ?? "-"}</dd>
              </div>
            </dl>
          </section>

          <section className="admin-panel">
            <div className="admin-panel-heading">
              <div>
                <p className="eyebrow">Maintenance</p>
                <h2>Operations</h2>
              </div>
            </div>
            <div className="admin-maintenance">
              <button type="button" onClick={() => void runMaintenance("prune", pruneResults, "Old results pruned")} disabled={busy !== null}>
                <Database size={18} />
                <span>Prune results</span>
              </button>
              <button type="button" onClick={() => void runMaintenance("reset", resetActiveTests, "Active sessions reset")} disabled={busy !== null}>
                <UsersRound size={18} />
                <span>Reset active tests</span>
              </button>
              <button
                className="danger"
                type="button"
                onClick={() => {
                  if (window.confirm("Delete all saved speed-test results?")) {
                    void runMaintenance("delete", deleteResults, "Results deleted");
                  }
                }}
                disabled={busy !== null}
              >
                <Trash2 size={18} />
                <span>Delete results</span>
              </button>
            </div>
          </section>
        </aside>
      </section>

      <section className="admin-panel admin-events">
        <div className="admin-panel-heading">
          <div>
            <p className="eyebrow">Audit</p>
            <h2>Recent Admin Events</h2>
          </div>
        </div>
        {events.length === 0 ? (
          <div className="empty-history">No events</div>
        ) : (
          <div className="admin-event-list">
            {events.map((event) => (
              <article className="admin-event" key={event.id}>
                <strong>{event.action}</strong>
                <span>{formatDate(event.createdAt)}</span>
                <code>{JSON.stringify(event.metadata)}</code>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

function AdminHeader({ authenticated, onLogout }: { authenticated: boolean; onLogout: () => void }) {
  return (
    <header className="topbar admin-topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">
          <Settings size={22} strokeWidth={2.3} />
        </span>
        <div>
          <p className="eyebrow">Ping Pong</p>
          <h1>Admin Console</h1>
        </div>
      </div>
      <div className="topbar-status">
        <a className="server-pill" href="/">
          <ArrowLeft size={17} />
          <span>Speed Test</span>
        </a>
        {authenticated ? (
          <button className="server-pill admin-logout" type="button" onClick={onLogout}>
            <LogOut size={17} />
            <span>Logout</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

function sendLeaveLogout() {
  if (navigator.sendBeacon && navigator.sendBeacon("/api/admin/logout")) {
    return;
  }

  void fetch("/api/admin/logout", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    keepalive: true
  }).catch(() => undefined);
}

function CatSpeedRangeEditor({
  ranges,
  onChange
}: {
  ranges: CatSpeedRanges;
  onChange: (stage: CatSpeedStage, key: keyof CatSpeedRange, value: number | null) => void;
}) {
  return (
    <section className="admin-speed-ranges" aria-label="Cat speed animation ranges">
      <div className="admin-range-heading">
        <div>
          <p className="eyebrow">Animation</p>
          <h3>Cat Speed Ranges</h3>
        </div>
        <span>Mbps</span>
      </div>
      <div className="admin-range-list">
        {CAT_SPEED_STAGES.map((stage, index) => {
          const range = ranges[stage];
          const isSprint = stage === "sprint";
          return (
            <div className="admin-range-row" key={stage}>
              <strong>{catSpeedStageLabels[stage]}</strong>
              <label>
                <span>{index === 0 ? "From >=" : "From >"}</span>
                <input
                  value={range.minMbps}
                  type="number"
                  min={0}
                  max={1_000_000}
                  step={0.01}
                  onChange={(event) => onChange(stage, "minMbps", Number(event.target.value))}
                />
              </label>
              <label>
                <span>To &lt;=</span>
                {isSprint ? (
                  <input value="No limit" disabled readOnly />
                ) : (
                  <input
                    value={range.maxMbps ?? ""}
                    type="number"
                    min={0}
                    max={1_000_000}
                    step={0.01}
                    onChange={(event) => onChange(stage, "maxMbps", Number(event.target.value))}
                  />
                )}
              </label>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function NumberField({
  label,
  suffix,
  value,
  min,
  max,
  onChange
}: {
  label: string;
  suffix?: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="admin-field">
      <span>{label}</span>
      <div className="admin-number-input">
        <input value={value} type="number" min={min} max={max} onChange={(event) => onChange(Number(event.target.value))} />
        {suffix ? <em>{suffix}</em> : null}
      </div>
    </label>
  );
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-TW", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}
