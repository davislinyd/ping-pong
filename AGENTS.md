# Ping Pong Local Agent Rules

## Service Restart After Code Changes

- After every code change, restart the running service before final verification or handoff.
- Do not rely only on watcher reloads, Vite HMR, or `tsx watch` after changing code.
- Use the service mode that matches the current work:
  - development: restart `npm run dev`
  - production-style verification: rerun `npm run build`, then restart `npm start`
