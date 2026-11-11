/* ---------- Petits utilitaires de formatage (portés de public/app.js) ---------- */

export const pad = (n, l = 2) => String(n).padStart(l, '0');

export const fmtTs = (iso) => {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};

export const fmtInt = (v) => (v == null ? '—' : Math.round(v).toLocaleString('fr-FR'));
export const fmtNum = (v) => (v == null ? '—' : Number(v).toFixed(2));
export const fmtPct = (v) => (v == null ? '—' : v.toFixed(2) + ' %');

export function fmtBytesRate(v) {
  if (v == null) return '—';
  if (v < 1000) return `${Math.round(v)} B/s`;
  if (v < 1e6) return `${(v / 1e3).toFixed(1)} kB/s`;
  return `${(v / 1e6).toFixed(2)} MB/s`;
}

// Heure locale lisible (infobulles de survol).
export const timeLabel = (iso) => new Date(iso).toLocaleTimeString('fr-FR');
