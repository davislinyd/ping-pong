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

Development URLs:

- Frontend: `http://localhost:5173`
- API: `http://localhost:8080`

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
- warning banners appear when the browser is a local self-test or concurrent test capacity is near/full
- the main test panel groups the live Mbps readout, phase progress, current status, and start/retest action
- the current status area shows accumulated `Total Download` and `Total Upload` in megabits (`Mb`) for the current test only
- Download and Upload are shown as primary speed metrics inside the main panel
- Idle Latency, Loaded Latency, Jitter, and HTTP Loss are shown as secondary quality metrics below the main row
- the live readout and each metric card include process sparklines for the current test run
- clicking any of the six metric cards opens a centered detail dialog with the same label, value, unit, and an enlarged trend chart
- hovering the enlarged trend chart shows the nearest sample number and value; the hover marker is a small filled point and the compact card sparklines remain line-only
- Your Recent Results appears directly below the test panel as a compact browser-scoped history chart with hover/focus details for timestamp, download, and upload

The layout is responsive: desktop uses an internal two-column panel for the live readout and controls, while tablet and mobile stack the same content without changing the measurement flow.

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

Download and upload are sampled in 250 ms throughput windows after a short warmup. The primary speed value is P50 Typical, with P10 Low and P90 High shown as supporting statistics so short spikes or dips do not dominate the result.

The accumulated `Total Download` and `Total Upload` row uses the same warmup-adjusted effective transfer bytes as the throughput calculation, converted to decimal megabits. It is a current-test UI value only; it is not saved in Recent Results and does not change the server result schema.

The browser speed-test work runs inside a module Web Worker. The main page keeps active-test sessions, heartbeats, result saving, and Recent Results management on the UI thread, then terminates the Worker after completion, Retest, error, or page unmount. This releases the test-time JavaScript heap, timers, upload payload buffers, sampler arrays, AbortController state, and stream-reader references without reloading the page. Browsers can still keep network-process memory for a short time, so this reduces the page's retained test memory rather than forcing the operating system to immediately reclaim all RAM.

Existing `.env` files or SQLite runtime settings keep their current test duration until you change them directly or through the admin console.

Set `TRUST_PROXY=true` only when the service is behind a trusted internal reverse proxy that forwards client IP headers.

`ADMIN_PASSWORD` enables the admin console at `/admin`. Leave it empty to disable admin changes. Runtime settings changed from the admin console are stored in SQLite and take effect immediately; startup settings such as `PORT`, `HOST`, `SQLITE_PATH`, and `TRUST_PROXY` still come from `.env` and require a service restart.

## Admin Console

Open:

```text
http://<intranet-host>:8080/admin
```

The admin console can update:

- server display name
- test duration
- parallel connections
- max request payload
- result retention days
- local self-test allowance
- concurrent test warning and maximum thresholds

It also provides maintenance actions to prune old results, reset stuck active-test sessions, and delete saved results with confirmation.

## API

- `GET /api/health`
- `GET /api/config`
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

Saved fields include:

- timestamp
- server name
- download/upload P50 Mbps plus P10/P90 summary stats and sample counts
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

For UI changes, also check the homepage at desktop, tablet, and mobile widths to confirm the test panel, metric groups, and Recent Results chart do not overlap or overflow.

When checking metric detail interactions, confirm all six metric cards open the detail dialog, the main live readout does not open a dialog, hover over the enlarged chart shows the nearest sample value, and Esc, backdrop click, and the close button all dismiss the dialog.

## Non-Container Deployment

Examples are provided in:

- `docs/ping-pong.service` for Linux systemd
- `docs/com.pingpong.speedtest.plist` for macOS LaunchAgent

For a simple Linux VM deployment, place the project under `/opt/ping-pong`, run `npm ci && npm run build`, copy `.env.example` to `.env`, adjust values, then install the systemd unit.
