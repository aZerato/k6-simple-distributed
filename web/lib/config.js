// URL de l'orchestrateur (API HTTP + canal Socket.io).
//
//  - build export servi par l'orchestrateur (web/out) : même origine → '' ;
//  - dev Next séparé (`next dev -p 3001`) : définir
//    NEXT_PUBLIC_ORCHESTRATOR_URL=http://localhost:3000 (ou l'URL réelle).
export const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? '';

// Base des appels /api/* (même origine par défaut).
export const API_BASE = ORCHESTRATOR_URL;

/* ---------- Constantes & plafonds (identiques à la console legacy) ---------- */

export const HISTORY_MAX = 1800; // snapshots par seconde conservés côté client
export const MAX_LOG_KEEP = 5000; // lignes conservées par worker (mémoire)
export const MAX_DOM_LINES = 3000; // lignes rendues dans le DOM de la vue de logs
export const SPARK_LEN = 120; // points des sparklines des cartes
