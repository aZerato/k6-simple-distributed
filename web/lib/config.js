// Orchestrator URL (HTTP API + Socket.io channel).
//
//  - export build served by the orchestrator (web/out): same origin -> '';
//  - separate Next dev (`next dev -p 3001`): set
//    NEXT_PUBLIC_ORCHESTRATOR_URL=http://localhost:3000 (or the real URL).
export const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? '';

// Base of the /api/* calls (same origin by default).
export const API_BASE = ORCHESTRATOR_URL;

/* ---------- Constants & caps (identical to the legacy console) ---------- */

export const HISTORY_MAX = 1800; // per-second snapshots kept on the client
export const MAX_LOG_KEEP = 5000; // lines kept per worker (memory)
export const MAX_DOM_LINES = 3000; // lines rendered in the DOM of the logs view
export const SPARK_LEN = 120; // points of the cards' sparklines
