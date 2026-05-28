# Analysis Data Debugging

Use this checklist when Ping Pong numbers look inconsistent across the homepage, Recent Results, API responses, SQLite, or downloaded IT reports.

## Reconciliation Flow

1. Run the deterministic checks first:
   - `npm run typecheck`
   - `npm test -- test/metrics.test.ts test/speed-test-core.test.ts test/result-summary.test.ts test/report-export.test.ts test/api.test.ts`
2. Complete one browser test and capture these sources for the same run:
   - homepage metric cards and detail dialogs
   - `POST /api/results` response, if browser tooling captures it
   - `GET /api/results/recent?limit=1&includeLocal=true` with the same browser id
   - the newest SQLite `results` row
   - downloaded HTML or PNG IT report
3. Compare each source with the table below. If a value diverges, isolate in this order:
   - Worker progress values
   - final `ResultPayload`
   - `POST /api/results` payload and response
   - SQLite row
   - UI or report rendering

## Manual Reconciliation Table

| source | downloadMean | downloadP10/P50/P75/P90 | downloadCV | downloadSamples | uploadMean | uploadP10/P50/P75/P90 | uploadCV | uploadSamples | idleLatency | downloadLoadedLatency | uploadLoadedLatency | jitter | loss | totalDownloadMb | totalUploadMb |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| homepage |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| recent-api |  |  |  |  |  |  |  |  |  |  |  |  |  | n/a | n/a |
| sqlite |  |  |  |  |  |  |  |  |  |  |  |  |  | n/a | n/a |
| report |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

`downloadSamples` and `uploadSamples` should record both raw and IQR-filtered counts, for example `42 raw / 40 filtered`.

## Expected Data Boundaries

- Download and Upload primary speeds are trimmed means from warmup-adjusted throughput samples, not P50 values.
- Percentiles remain based on raw steady samples after the startup sample is dropped.
- CV uses the same IQR-filtered sample set as the primary mean.
- Total Download and Total Upload are current-test warmup-adjusted megabits and are not stored in SQLite.
- Recent Results are scoped to the current browser/device id; legacy rows without that scope should not appear.
