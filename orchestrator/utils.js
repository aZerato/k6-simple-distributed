// Small formatting utilities (dates, bytes) shared by the modules.

export function pad(n, l = 2) { return String(n).padStart(l, '0'); }

export function stamp(d) {
  const dt = new Date(d);
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}.${pad(dt.getMilliseconds(), 3)}`;
}

export function dateFull(d) {
  const dt = new Date(d);
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()} ${stamp(dt)}`;
}

export function fmtBytes(v) {
  if (v == null) return '—';
  const a = Math.abs(v);
  if (a < 1000) return `${Math.round(v)} B`;
  if (a < 1e6) return `${(v / 1e3).toFixed(1)} kB`;
  if (a < 1e9) return `${(v / 1e6).toFixed(1)} MB`;
  return `${(v / 1e9).toFixed(1)} GB`;
}

// Duration helpers (k6-style "2m"/"30s"/"2h" -> seconds, and back).
export function parseDurationSeconds(d) {
  const m = typeof d === 'string' && /^([0-9]+)([smh])$/.exec(d);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
}

export function formatSeconds(s) {
  return s >= 60 && s % 60 === 0 ? `${s / 60}m` : `${Math.ceil(s)}s`;
}
