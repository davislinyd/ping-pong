# Ping Pong Local Agent Rules

## Service Restart After Code Changes

- After every code change, restart the running service before final verification or handoff.
- Do not rely only on watcher reloads, Vite HMR, or `tsx watch` after changing code.
- Use the service mode that matches the current work:
  - development: restart `npm run dev`
  - production-style verification: rerun `npm run build`, then restart `npm start`

## Homepage UI Documentation And Verification

- After homepage UI or layout changes, update `README.md` and `.ai/status.json` before handoff.
- Keep README's User Interface and Verification sections aligned with the actual desktop/tablet/mobile layout behavior.
- For desktop one-screen layout work, verify `1089x964`, `1280x900`, and `1710x1021`; full-page height should match viewport height, top-row cards should keep equal width, and the live readout card should not be vertically stretched by empty space.
- Mobile and tablet layouts may remain vertically scrollable as long as all homepage content is reachable and does not overlap.
