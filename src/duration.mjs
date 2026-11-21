const TIME = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
const SIZE = { b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 };

/** "300ms" | "15s" | "20m" | "2h" | "45" (seconds) | number (ms) -> milliseconds */
export function parseDuration(v) {
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(String(v));
  if (!m) throw new Error(`bad duration: ${v}`);
  return Math.round(Number(m[1]) * TIME[(m[2] || 's').toLowerCase()]);
}

/** "3g" | "512m" | "100k" | "0" -> bytes */
export function parseBytes(v) {
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([bkmg])?b?\s*$/i.exec(String(v));
  if (!m) throw new Error(`bad size: ${v}`);
  return Math.round(Number(m[1]) * SIZE[(m[2] || 'b').toLowerCase()]);
}

export function formatBytes(n) {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)}M`;
  return `${Math.round(n / 1024)}K`;
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
  return `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h`;
}
