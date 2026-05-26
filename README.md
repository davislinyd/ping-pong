# Ping Pong Intranet Speed Test

Ping Pong is a single-node intranet network speed test website. It measures the browser-to-server path inside the company network and presents an integrated test panel with download, upload, idle latency, loaded latency, jitter, HTTP loss, and recent anonymous results.

The app is intentionally non-containerized: one Node.js service serves both the Fastify API and the built React frontend.

If the browser runs on the same machine as the speed-test service, the app treats it as a local self-test. Those numbers are useful only for checking that the app works because they measure loopback or the host network stack, not the real intranet path.

Local self-tests are blocked by default. Set `ALLOW_LOCAL_SELF_TEST=true` only for short maintenance checks when you intentionally want to test the app from the server itself. When a local self-test is allowed, the browser automatically uses the `Local throttled` profile: one connection, smaller payloads, and about 32 Mbps of paced traffic so the maintenance run can finish without overwhelming the local browser tab. Those results remain marked as local maintenance checks and are not valid intranet throughput measurements.

## Requirements

- Node.js 24 LTS or newer
- npm
- A host reachable from the company intranet

## Quick Start

```bash
cp .env.example .env
npm install
npm run dev
```

In development mode the Vite frontend and the Fastify API run on separate ports. The browser calls the API directly, so you must tell Vite where the API is. Create `.env.development` next to `.env` and set `VITE_API_BASE` to the API server address:

```text
VITE_API_BASE=http://<host>:<PORT>
```

Replace `<host>` with the machine's intranet IP or hostname and `<PORT>` with the value you set in `.env` (default `8080`). The frontend reads this at build time via Vite's `VITE_*` variable injection. Leave the file out or set `VITE_API_BASE=` to use relative URLs, which only works when the browser is on the same machine as the dev server.

The API server enables CORS automatically when `NODE_ENV=development` so the browser can reach it across ports without a proxy.

Development URLs:

- Frontend: `http://<host>:5173`
- API: `http://<host>:<PORT>` (default `8080`)

Production-style local run:

```bash
npm ci
npm run build
npm start
```

Default production URL:

```text
http://<intranet-host>:8080
```

## User Interface

The user homepage at `/` is focused on one speed-test workflow:

- top status pills show active test capacity and the running app version, currently `v0.2.0`
- the browser tab uses a generated pixel-style download-over-WiFi favicon with transparent space outside the frame
- the running app version pill doubles as a hidden admin entry: click it five times in a row to open `/admin`
- warning messages appear in a fixed-height carousel card with a top-right position counter such as `1/2`; the carousel rotates every 2 seconds, pauses while hovered or focused, keeps warning copy short, uses a one-line marquee for overflowing message text, always includes the mobile hotspot data-plan warning with a red title, and adds local self-test or concurrent test capacity warnings when applicable; allowed local self-tests also show `Local throttled`
- the main test panel groups the live Mbps readout, phase progress, current status, and start/retest action
- the current status area shows the server-seen `Client IP` and whether it came directly from the request or from trusted proxy handling; the value is refreshed before each test starts
- the current status area requires a simple `Wired` or `Wi-Fi` button choice before each test starts; the choice is saved with that run
- the current status area offers fixed `Quick 20s` and `Full 30s` test modes; Quick is selected by default, and the selected duration is saved as `durationSeconds`
- the current status area shows accumulated `Total Download` and `Total Upload` in megabits (`Mb`) for the current test only
- after a completed test, a compact `HTML` / `PNG` / `Markdown` IT report download row and `Raw Data` action appear near the retest action without changing the main dashboard layout
- Download and Upload are shown as primary speed metrics inside the main panel
- Idle Latency, Loaded Latency, Jitter, and HTTP Loss are shown as secondary quality metrics below the main row
- the live readout and each metric card include process sparklines for the current test run
- clicking any of the six metric cards opens a centered detail dialog with the same label, value, unit, and an enlarged trend chart
- hovering the enlarged trend chart shows the nearest sample number and value; the hover marker is a small filled point and the compact card sparklines remain line-only
- desktop keeps the top row in two equal-width cards: the left card contains only the live readout, chart, and progress; the right card contains current status, accumulated transfer, the action button, and primary speed metrics
- the desktop top row sizes to its content instead of stretching to fill leftover dashboard height, so the live readout card stays visually compact
- Your Recent Results appears directly below the test panel as a compact browser-scoped history strip with hover/focus details for timestamp, selected link type, client IP, download, and upload; clicking or pressing a result opens a popup with the saved test record, including the server-seen client IP captured when that test was saved, and the active result's download/upload bars brighten with subtle outlines while the tooltip is visible

The layout is responsive: desktop is tuned for one-screen operation at normal desktop heights, while tablet and mobile stack the same content and remain scrollable without changing the measurement flow.

## Configuration

Configure the service with `.env`.

```text
PORT=8080
HOST=0.0.0.0
TEST_SERVER_NAME=Ping Pong Intranet
SQLITE_PATH=./data/ping-pong.sqlite
HISTORY_RETENTION_DAYS=30
DEFAULT_TEST_DURATION_SECONDS=15
PARALLEL_CONNECTIONS=4
MAX_TEST_BYTES=67108864
TRUST_PROXY=false
ALLOW_LOCAL_SELF_TEST=false
ACTIVE_TEST_WARNING_THRESHOLD=2
MAX_ACTIVE_TESTS=4
ADMIN_PASSWORD=
ADMIN_SESSION_TTL_HOURS=8
```

`MAX_TEST_BYTES` limits a single download or upload request. The browser loops requests for the configured test duration instead of asking for one giant body.

Download and upload are sampled in 250 ms throughput windows after a short warmup. The homepage uses fixed `Quick 20s` and `Full 30s` modes instead of the admin default duration; the admin/runtime default remains a fallback and compatibility setting. Before summary statistics are calculated, the first `ceil(sample_count × 3%)` post-warmup throughput samples are discarded, capped so at least one sample remains. The primary speed value is the **stable trimmed mean**: the remaining throughput samples are sorted, samples outside the IQR fence (Q1 − 1.5×IQR, Q3 + 1.5×IQR) are dropped, and the arithmetic mean of the retained samples is reported. P10 Low, P50 Typical, P75/Q3, and P90 High percentiles are calculated from the startup-trimmed samples before IQR filtering. P25/Q1 is used to calculate the IQR fence but is not shown in the main card detail because P10 already represents low-speed experience, P50 represents the typical value, and P75/Q3 plus P90 cover upper-range capability without adding another low-percentile tile. The card detail instead shows `IQR kept` with kept sample counts and outlier rate. Raw CV is calculated before IQR filtering to expose Wi-Fi-style variability; Stable CV is calculated after IQR filtering to describe the stable-speed estimate. Download requests are 16 MB per chunk, streamed and sampled continuously. Upload requests are 256 KB per chunk so that more round-trip completions fit inside the test window and the upload sample count stays comparable to download.

The completion summary is stability-first. HTTP loss, Raw CV, P10/Mean ratio, IQR outlier rate, jitter, and loaded latency determine the main bottleneck before speed does; speed remains visible as its own tile and becomes the main limit only when it falls into the unusable speed tier. Wired and legacy Unknown runs use strict wired-grade stability thresholds. Wi-Fi runs use a usability-aware stability profile: Raw CV, outlier rate, and jitter are still shown, but P10 is judged with both its ratio to the stable mean and its absolute Mbps so a high-throughput Wi-Fi link is not marked unusable only because it is more variable than wired. Poor Wi-Fi reliability, very high jitter, very low P10, or multiple poor stability signals still recommend retrying on Wired to isolate the wireless segment; fair Wi-Fi variability is reported as usable when the application experience is acceptable. If a Wired run is still poor, it points IT toward the switch, uplink, or server path. A normal browser page cannot reliably detect true Ethernet vs Wi-Fi or Wi-Fi RSSI/SSID, so the selected link type is a required user label rather than an automatic hardware reading.

The accumulated `Total Download` and `Total Upload` row uses the same warmup-adjusted effective transfer bytes as the throughput calculation, converted to decimal megabits. It is a current-test UI value only; it is not saved in Recent Results and does not change the server result schema.

The browser speed-test work runs inside a module Web Worker. The main page keeps active-test sessions, heartbeats, result saving, and Recent Results management on the UI thread, then terminates the Worker after completion, Retest, error, or page unmount. This releases the test-time JavaScript heap, timers, upload payload buffers, sampler arrays, AbortController state, and stream-reader references without reloading the page. Browsers can still keep network-process memory for a short time, so this reduces the page's retained test memory rather than forcing the operating system to immediately reclaim all RAM.

The completed test also keeps current-run raw samples in browser memory only. The `Raw Data` popup is available only for the just-completed run and is not stored in SQLite or exposed through Recent Results. Download and upload throughput rows are labeled `used`, `startup-excluded`, or `iqr-excluded` using the same startup trim and IQR rules as the stable mean. Latency rows mark successful samples used or IQR-excluded for medians, while failed latency attempts are excluded from medians but still counted for HTTP Loss. The popup can download the same rows as CSV for offline review.

The completed-test IT report is generated only when the user clicks `HTML`, `PNG`, or `Markdown`. All three formats are built from the same report snapshot and start with a network-quality judgment for human and AI review: verdict, primary limit, selected link type, core speed/latency/loss values, client IP, and context status. HTML and PNG keep a clean modern visual layout with the judgment summary before the `Test Charts` section. Markdown downloads a `.md` file with an AI-readable YAML-style summary followed by human-readable tables. Reports combine the saved result with current browser diagnostics and request context, including selected link type, client IP, coarse IP, browser family, User-Agent, platform, language, timezone, screen/viewport size, device pixel ratio, CPU thread hint, device memory hint, and browser Network Information API hints when available. Its speed-result rows show Stable Mean, P10/P50/P75/P90, Raw CV, Stable CV, and samples kept from the saved result. If `/api/report-context` is unavailable, the export still succeeds with missing fields marked as `Unavailable`.

Existing `.env` files or SQLite runtime settings keep their current test duration until you change them directly or through the admin console.

Set `TRUST_PROXY=true` only when the service is behind a trusted internal reverse proxy that forwards client IP headers.

`ADMIN_PASSWORD` enables the admin console at `/admin`. Leave it empty to disable admin changes. Runtime settings changed from the admin console are stored in SQLite and take effect immediately; startup settings such as `PORT`, `HOST`, `SQLITE_PATH`, and `TRUST_PROXY` still come from `.env` and require a service restart.

## Admin Console

Open directly:

```text
http://<intranet-host>:8080/admin
```

The homepage also exposes a hidden entry for operators: click the top-right version pill five times in a row, then the page opens `/admin`. If the browser is not authenticated, the existing Admin Login password screen appears.

The admin console can update:

- server display name
- test duration
- parallel connections
- max request payload
- result retention days
- local self-test allowance
- whether leaving Admin Console requires password entry on the next visit
- concurrent test warning and maximum thresholds

It also provides maintenance actions to prune old results, reset stuck active-test sessions, and delete saved results with confirmation.

## API

- `GET /api/health`
- `GET /api/config`
- `GET /api/report-context`
- `GET /api/latency`
- `GET /api/download?bytes=n`
- `POST /api/upload`
- `POST /api/results` (`X-Ping-Pong-Browser-Id` scopes the saved result to the browser/device when present)
- `GET /api/results/recent?limit=50` (`X-Ping-Pong-Browser-Id` is required for browser/device-scoped results)
- `DELETE /api/results` (`X-Ping-Pong-Browser-Id` deletes only that browser/device's saved results)
- `GET /api/active-tests`
- `POST /api/active-tests`
- `POST /api/active-tests/:sessionId/heartbeat`
- `DELETE /api/active-tests/:sessionId`
- `GET /api/admin/session`
- `POST /api/admin/login`
- `POST /api/admin/logout`
- `GET /api/admin/settings`
- `PATCH /api/admin/settings`
- `GET /api/admin/status`
- `GET /api/admin/events`
- `POST /api/admin/results/prune`
- `DELETE /api/admin/results`
- `POST /api/admin/active-tests/reset`

Active test counts are stored in memory and expire automatically when a browser stops sending heartbeats. By default, the UI warns at 2 concurrent tests and blocks new starts when 4 tests are already running.

## Data Privacy

SQLite stores recent anonymous measurement rows plus the raw server-seen client IP captured for each saved test result. It does not store accounts, cookies, tokens, full user-agent strings, raw browser identifiers, or private user content.

The homepage displays the current server-seen client IP from the no-store `/api/report-context` response so users can confirm which address the test server sees before running. When a test result is saved, the backend stores the same class of server-seen `request.ip` value with that result so Recent Results can show the IP used for that specific test. This is not a browser-discovered local network-interface address or public egress IP lookup.

Admin event logs store only action names and small metadata such as changed setting keys or changed row counts. They do not store the admin password, raw IP address, cookies, tokens, or full user-agent strings.

Downloaded IT reports can include raw client IP and full browser User-Agent because the user explicitly generates the file for IT evaluation. The full User-Agent remains report-only; the saved test result already contains the server-seen client IP used by Recent Results. `/api/report-context` does not return cookies, tokens, authorization headers, or full request headers.

Saved fields include:

- timestamp
- server name
- download/upload stable trimmed-mean Mbps plus P10/P50/P75/P90 percentiles, Raw CV, Stable CV, and sample counts after startup trim and post-IQR-filter
- idle and loaded latency
- jitter and HTTP loss
- duration and parallel connection count
- test profile (`Standard` or `Local throttled`)
- selected network link type (`Wired`, `Wi-Fi`, or legacy `Unknown`)
- server-seen client IP for that saved test result; rows saved before this field existed show `Not recorded` in the UI
- browser family
- hashed client id derived from a coarse network address and browser family
- hashed browser/device id used only to keep Recent Results scoped to the same browser
- whether the result came from a local self-test

Your Recent Results is scoped to the same browser/device and includes that browser's local self-tests so maintenance runs are visible to the person who ran them. Local self-tests still show the warning banner because they are not real intranet measurements. Allowed local self-tests are saved and exported with the `Local throttled` profile label. Existing rows created before browser/device scoping do not appear in personal Recent Results because they cannot be safely assigned to one browser.

Users can delete their own browser/device-scoped Recent Results from the homepage. This does not delete other users' rows or legacy rows without a browser/device hash. Admin Console deletion remains the only UI path for clearing all saved results.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm start
```

Then check:

```bash
curl http://127.0.0.1:8080/api/health
```

Open `http://127.0.0.1:8080` to verify the page loads. Because local self-tests are blocked by default, run a valid speed test from another intranet device unless `ALLOW_LOCAL_SELF_TEST=true` is temporarily enabled for maintenance. When local self-test is enabled, confirm the banner shows `Local throttled`, Quick 20s can complete without crashing the browser tab, and saved/detail/report surfaces keep the `Local throttled` label.

For UI changes, also check the homepage at desktop, tablet, and mobile widths to confirm the warning carousel, test panel, connection IP strip, link-type buttons, Quick/Full duration selector, metric groups, and Recent Results chart do not overlap or overflow. For desktop layout work, verify `1089x964`, `1280x900`, and `1710x1021`: the full-page height should match the viewport height, the two top-row cards should have equal width, the live readout card should not be vertically stretched by empty space, and Download/Upload primary metric cards should not overlap the secondary quality metrics. Mobile viewports may remain vertically scrollable as long as all content is reachable. Confirm the warning carousel keeps a fixed 64px desktop/tablet height and 72px mobile height, shows the top-right position counter, rotates every 2 seconds, pauses on hover or focus, can move between hotspot, local self-test, or capacity warnings when multiple warnings are active, renders the hotspot title in red, and uses the one-line marquee only when message text overflows. Confirm the current status area shows `Client IP` and `Source` from `/api/report-context`; if that endpoint is unavailable, the homepage should show `Connection unavailable` without blocking the speed-test controls. Confirm `Quick 20s` is selected by default and `Full 30s` can be selected before starting a run. When checking Recent Results, confirm hover and keyboard focus both show the tooltip with selected link type, saved client IP, and `Local throttled` profile when applicable; confirm the active download/upload bars brighten, and confirm click or keyboard activation opens the saved-record popup with `Client IP` and `Profile` tiles. Legacy rows without a stored IP should show `Not recorded`.

When checking metric detail interactions, confirm all six metric cards open the detail dialog, the main live readout does not open a dialog, hover over the enlarged chart shows the nearest sample value, and Esc, backdrop click, and the close button all dismiss the dialog.

When checking the hidden admin entry, confirm the top-right version pill remains visually unchanged, keeps the normal cursor on hover, is the only `button.version-pill`, and opens `/admin` after five rapid clicks.

When checking the site icon, confirm the browser tab loads the generated pixel-style `favicon.png` without a missing-icon fallback, and that the area outside the icon frame is transparent.

When checking IT report export, complete a test after selecting `Wired` or `Wi-Fi` and confirm the compact `HTML`, `PNG`, `Markdown`, and `Raw Data` buttons appear only after completion. Download all three report formats, verify the HTML opens as a self-contained report with the selected link type and `Test Charts` SVG section, verify the PNG text and chart section are readable, verify the Markdown contains the AI-readable summary plus human-readable tables, and confirm the homepage layout remains unchanged at the desktop viewport checks above. Open `Raw Data`, confirm throughput and latency rows show which samples were used or excluded, confirm Esc, backdrop click, and the close button dismiss the popup, and download the CSV to confirm it includes `test_id`, `created_at`, `group`, `phase`, `sample_index`, `status`, `used_in`, and `excluded_from`.

For analysis-data debugging, use `docs/analysis-data-debugging.md` to reconcile the homepage, Recent Results API, SQLite row, and downloaded report for the same run. The focused regression command is:

```bash
npm test -- test/metrics.test.ts test/speed-test-core.test.ts test/result-summary.test.ts test/report-export.test.ts test/api.test.ts
```

## Non-Container Deployment

Examples are provided in:

- `docs/ping-pong.service` for Linux systemd
- `docs/com.pingpong.speedtest.plist` for macOS LaunchAgent

For a simple Linux VM deployment, place the project under `/opt/ping-pong`, run `npm ci && npm run build`, copy `.env.example` to `.env`, adjust values, then install the systemd unit.
