// Memory / console caps — single source of truth for the whole orchestrator.

// --- MEMORY / CONSOLE LIMITS ---
export const MAX_SESSIONS = 10;                 // sessions kept (newest first)
export const MAX_LOG_LINES_PER_WORKER = 5000;  // log lines kept per worker / session
export const RING_CAPACITY = 5000;              // recent values kept per metric (percentiles)
export const MAX_HISTORY_ROWS = 1800;           // per-second snapshots kept per session
export const MAX_RAW_LINES_PER_WORKER = 200000; // raw k6 JSON lines kept per worker
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10 * 1024 * 1024; // data files (CSV, etc.) total size per test