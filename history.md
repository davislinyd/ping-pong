# Ping Pong Project Status

Last updated: 2026-05-19T00:00:00+08:00

## Current Goal

Maintain Ping Pong as a single-node intranet speed-test service with browser-scoped Recent Results, multi-stat throughput reporting, current-test transfer display, Web Worker execution, compact IT diagnostic report export, a desktop one-screen dashboard, Admin Console controls, local production health checks, and OctoPulse visibility.

## Latest Summary

Ping Pong is a Node.js 24 Fastify + React app for intranet speed testing. Completed tests now expose compact `HTML` and `PNG` IT diagnostic report downloads near the existing retest action without moving the main dashboard cards or Recent Results. Reports now include a `Test Charts` section with the current run's download, upload, idle latency, loaded latency, jitter, and HTTP loss graphs before the numeric diagnostic sections. Reports also combine the saved result with request context from the no-store `GET /api/report-context` endpoint and browser-side diagnostics such as User-Agent, platform, timezone, viewport, screen, CPU thread hint, device memory hint, and Network Information API hints when available. Raw client IP and full User-Agent appear only in user-downloaded report files and are not stored in SQLite by this export flow. The existing speed-test flow, active-test heartbeat, result saving, personal history deletion, Admin Console, metric detail modal, generated favicon, and layout structure are preserved.

The dev setup was rearchitected to remove the Vite proxy. The browser now calls the Fastify API directly on its own port. `@fastify/cors` is registered in development mode so cross-port requests succeed without a proxy. Frontend fetch calls use a `VITE_API_BASE` env var (set via `.env.development`) so the build-time URL is explicit and production relative URLs are unaffected. The upload chunk size was reduced from 1 MB to 256 KB to increase upload sample density and bring upload sample counts closer to download.

Throughput statistics were refactored: the primary download/upload speed is now a **trimmed mean** computed after IQR outlier filtering (samples outside Q1 − 1.5×IQR ~ Q3 + 1.5×IQR are dropped), instead of the previous P50. The on-screen metric panel reports P10 / P50 / P75 / P90 percentiles and a **coefficient of variation (CV)** that drives the stability grade, replacing the older `(P90 − P10) / P50` spread. `ThroughputStats` was extended with `meanMbps`, `p75Mbps`, `cvPercent`, and `filteredSampleCount`; the `results` table received six matching columns with a backfill migration so historical rows still render (CV is 0 for them since the original sample distribution is unrecoverable). The IT report PDF/HTML export now lists Mean, all four percentiles, CV, and sample counts.

## Next Action

If IT needs deeper machine-level data such as Wi-Fi SSID, MAC address, hostname, route table, or CPU model, plan a separate native helper or browser extension because the current browser-only page cannot collect those fields.

## Verification

- `npm run typecheck` passed.
- `npm test` passed: 8 test files and 62 tests.
- `npm run build` passed.
- Production service on port 8080 was restarted after the build; the current listener is `node dist/server/main.js` PID 40029 under `npm start` PID 39901.
- `curl -sS http://127.0.0.1:8080/api/health` returned healthy service metadata.
- `curl -sS -D - http://127.0.0.1:8080/api/report-context -H 'User-Agent: Mozilla/5.0 Chrome/120.0'` returned `200 OK`, no-store headers, client IP/coarse IP, browser family, and client safety data without raw header dumps.
- In-app browser verification loaded `http://127.0.0.1:8080/`, completed a local self-test, and confirmed `HTML` / `PNG` report buttons appear only after completion.
- Playwright CLI downloaded both chart-bearing reports from the completed state: `/tmp/ping-pong-report-chart.html` and `/tmp/ping-pong-report-chart.png`.
- Downloaded HTML contains `Test Charts`, six SVG chart elements, and chart polylines; downloaded PNG is a readable 1080 x 3853 PNG with the chart section included.
- Desktop layout checks passed at `1089x964`, `1280x900`, and `1710x1021`: page height matched viewport height, top-row card widths were equal, Recent Results stayed below the test panel, and the report buttons stayed compact.
- Tablet/mobile checks at `768x1024` and `390x844` showed reachable vertical content and no horizontal overflow for the report controls or main homepage sections.
- `git diff --check` passed.
- OctoPulse status JSON validation passed.
- OctoPulse scanner refreshed central outputs.

## Attention

- Local self-tests still show a warning because they are not real intranet measurements.
- Dev mode requires `.env.development` with `VITE_API_BASE=http://<host>:<PORT>` so the browser can reach the API server directly. Without this the frontend sends requests to the Vite dev server, which returns `index.html` for unknown routes.
- Report export is intentionally browser-only and does not collect machine data unavailable to normal webpages, such as Wi-Fi SSID, MAC address, hostname, route table, or CPU model.
