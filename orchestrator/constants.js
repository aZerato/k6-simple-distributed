// Plafonds mémoire / console — source unique pour tout l'orchestrateur.

// --- LIMITES MÉMOIRE / CONSOLE ---
export const MAX_SESSIONS = 10;                 // sessions conservées (plus récentes d'abord)
export const MAX_LOG_LINES_PER_WORKER = 5000;  // lignes de logs conservées par worker / session
export const RING_CAPACITY = 5000;              // valeurs récentes conservées par métrique (percentiles)
export const MAX_HISTORY_ROWS = 1800;           // snapshots par seconde conservés par session
export const MAX_RAW_LINES_PER_WORKER = 200000; // lignes du JSON brut k6 conservées par worker
