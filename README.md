# Ping Pong Intranet Speed Test

Ping Pong is a single-node intranet network speed test website. It measures the browser-to-server path inside the company network and presents an integrated test panel with download, upload, idle latency, loaded latency, jitter, HTTP loss, and recent anonymous results.

The app is intentionally non-containerized: one Node.js service serves both the Fastify API and the built React frontend.

If the browser runs on the same machine as the speed-test service, the app treats it as a local self-test. Those numbers are useful only for checking that the app works because they measure loopback or the host network stack, not the real intranet path.

Local self-tests are blocked by default. Set `ALLOW_LOCAL_SELF_TEST=true` only for short maintenance checks when you intentionally want to test the app from the server itself.

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

- top status pills show active test capacity and the running app version
- the browser tab uses a generated pixel-style download-over-WiFi favicon with transparent space outside the frame
- the running app version pill doubles as a hidden admin entry: click it five times in a row to open `/admin`
- warning banners appear when the browser is a local self-test or concurrent test capacity is near/full
- the main test panel groups the live Mbps readout, phase progress, current status, and start/retest action
- the current status area shows accumulated `Total Download` and `Total Upload` in megabits (`Mb`) for the current test only
- after a completed test, a compact `HTML` / `PNG` IT report download row appears near the retest action without changing the main dashboard layout
- Download and Upload are shown as primary speed metrics inside the main panel
- Idle Latency, Loaded Latency, Jitter, and HTTP Loss are shown as secondary quality metrics below the main row
- the live readout and each metric card include process sparklines for the current test run
- clicking any of the six metric cards opens a centered detail dialog with the same label, value, unit, and an enlarged trend chart
- hovering the enlarged trend chart shows the nearest sample number and value; the hover marker is a small filled point and the compact card sparklines remain line-only
- desktop keeps the top row in two equal-width cards: the left card contains only the live readout, chart, and progress; the right card contains current status, accumulated transfer, the action button, and primary speed metrics
- the desktop top row sizes to its content instead of stretching to fill leftover dashboard height, so the live readout card stays visually compact
- Your Recent Results appears directly below the test panel as a compact browser-scoped history strip with hover/focus details for timestamp, download, and upload; the active result's download/upload bars brighten with subtle outlines while the tooltip is visible

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

Download and upload are sampled in 250 ms throughput windows after a short warmup. The primary speed value is the **trimmed mean**: throughput samples are sorted, samples outside the IQR fence (Q1 − 1.5×IQR, Q3 + 1.5×IQR) are dropped, and the arithmetic mean of the remaining samples is reported. P10 Low, P50 Typical, P75 Upper, and P90 High percentiles are still surfaced for reference, and the **coefficient of variation (CV = σ/mean, shown as a percentage)** is used as the stability indicator so it can be compared across very different link speeds. Download requests are 16 MB per chunk, streamed and sampled continuously. Upload requests are 256 KB per chunk so that more round-trip completions fit inside the test window and the upload sample count stays comparable to download.

The accumulated `Total Download` and `Total Upload` row uses the same warmup-adjusted effective transfer bytes as the throughput calculation, converted to decimal megabits. It is a current-test UI value only; it is not saved in Recent Results and does not change the server result schema.

The browser speed-test work runs inside a module Web Worker. The main page keeps active-test sessions, heartbeats, result saving, and Recent Results management on the UI thread, then terminates the Worker after completion, Retest, error, or page unmount. This releases the test-time JavaScript heap, timers, upload payload buffers, sampler arrays, AbortController state, and stream-reader references without reloading the page. Browsers can still keep network-process memory for a short time, so this reduces the page's retained test memory rather than forcing the operating system to immediately reclaim all RAM.

The completed-test IT report is generated only when the user clicks `HTML` or `PNG`. The report includes a `Test Charts` section with the current run's download, upload, idle latency, loaded latency, jitter, and HTTP loss graphs, then combines the saved result with current browser diagnostics and request context, including client IP, coarse IP, browser family, User-Agent, platform, language, timezone, screen/viewport size, device pixel ratio, CPU thread hint, device memory hint, and browser Network Information API hints when available. If `/api/report-context` is unavailable, the export still succeeds with missing fields marked as `Unavailable`.

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

SQLite stores only recent anonymous measurement rows. It does not store raw IP addresses, accounts, cookies, tokens, full user-agent strings, raw browser identifiers, or private user content.

Admin event logs store only action names and small metadata such as changed setting keys or changed row counts. They do not store the admin password, raw IP address, cookies, tokens, or full user-agent strings.

Downloaded IT reports can include raw client IP and full browser User-Agent because the user explicitly generates the file for IT evaluation. Those report-only details are not written to SQLite by the export flow, and `/api/report-context` does not return cookies, tokens, authorization headers, or full request headers.

Saved fields include:

- timestamp
- server name
- download/upload trimmed-mean Mbps plus P10/P50/P75/P90 percentiles, coefficient of variation (CV %), and sample counts (raw and post-IQR-filter)
- idle and loaded latency
- jitter and HTTP loss
- duration and parallel connection count
- browser family
- hashed client id derived from a coarse network address and browser family
- hashed browser/device id used only to keep Recent Results scoped to the same browser
- whether the result came from a local self-test

Your Recent Results is scoped to the same browser/device and includes that browser's local self-tests so maintenance runs are visible to the person who ran them. Local self-tests still show the warning banner because they are not real intranet measurements. Existing rows created before browser/device scoping do not appear in personal Recent Results because they cannot be safely assigned to one browser.

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

Open `http://127.0.0.1:8080` to verify the page loads. Because local self-tests are blocked by default, run a valid speed test from another intranet device unless `ALLOW_LOCAL_SELF_TEST=true` is temporarily enabled for maintenance.

For UI changes, also check the homepage at desktop, tablet, and mobile widths to confirm the test panel, metric groups, and Recent Results chart do not overlap or overflow. For desktop layout work, verify `1089x964`, `1280x900`, and `1710x1021`: the full-page height should match the viewport height, the two top-row cards should have equal width, and the live readout card should not be vertically stretched by empty space. Mobile viewports may remain vertically scrollable as long as all content is reachable. When checking Recent Results, confirm hover and keyboard focus both show the tooltip and brighten the active download/upload bars.

When checking metric detail interactions, confirm all six metric cards open the detail dialog, the main live readout does not open a dialog, hover over the enlarged chart shows the nearest sample value, and Esc, backdrop click, and the close button all dismiss the dialog.

When checking the hidden admin entry, confirm the top-right version pill remains visually unchanged, keeps the normal cursor on hover, is the only `button.version-pill`, and opens `/admin` after five rapid clicks.

When checking the site icon, confirm the browser tab loads the generated pixel-style `favicon.png` without a missing-icon fallback, and that the area outside the icon frame is transparent.

When checking IT report export, complete a test and confirm the compact `HTML` and `PNG` buttons appear only after completion. Download both formats, verify the HTML opens as a self-contained report with the `Test Charts` SVG section, verify the PNG text and chart section are readable, and confirm the homepage layout remains unchanged at the desktop viewport checks above.

## Non-Container Deployment

Examples are provided in:

- `docs/ping-pong.service` for Linux systemd
- `docs/com.pingpong.speedtest.plist` for macOS LaunchAgent

For a simple Linux VM deployment, place the project under `/opt/ping-pong`, run `npm ci && npm run build`, copy `.env.example` to `.env`, adjust values, then install the systemd unit.
