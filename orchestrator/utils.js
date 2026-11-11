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
