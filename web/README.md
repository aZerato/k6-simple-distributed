# Web Console Orchestrator (`web/`) — React / Next.js

The UI part is split into **React components** (one per panel), with the
same CSS style (moved into `web/app/globals.css`).
A single shared state (`hooks/useDashboard.js`): socket `ui:*`, displayed session /
"pinned" / RUNNING, snapshots, per-worker series, logs, "forced
refresh" watchdog — the components only keep their rendering. The canvas (charts,
sparklines, tooltip) stays a dependency-free imperative engine, in
`lib/charts.js`.

| File                           | Role                                                                          |
|--------------------------------|------------------------------------------------------------------------------|
| `app/layout.jsx` / `app/page.jsx` | Shell (fonts, global CSS) + page assembly                        |
| `hooks/useDashboard.js`           | "Brain": socket `ui:*`, sessions, rows, series, logs, watchdog           |
| `lib/config.js`                   | Orchestrator URL (`NEXT_PUBLIC_ORCHESTRATOR_URL`) + caps            |
| `lib/format.js`                   | Formatting (timestamps, numbers, bytes)                                     |
| `lib/charts.js`                   | Canvas engine (grid, curves, sparklines, tooltip) + series defs       |
| `components/TopBar.jsx`           | Top bar (brand, worker count, socket LED)                         |
| `components/WorkersPanel.jsx`     | Worker list (status Available / Busy)                               |
| `components/TestForm.jsx`         | Test launch (pasted script or `scriptPath`, targeted workers, VUS, duration, stop) |
| `components/Cards.jsx`            | Summary cards + canvas sparklines                                        |
| `components/ChartsGrid.jsx`       | 4 main charts + series checkboxes + global "Curves" mode (merged / per worker / all) |
| `components/MetricExplorer.jsx`   | Metric explorer: avg/p95 chart + per-source table              |
| `components/LogsPanel.jsx`        | Per-worker logs (tabs, auto-scroll, "Clear")                             |
| `components/ReportStrip.jsx`      | Report strip: sessions, raw k6 JSON, html/json/txt/jsonl downloads  |