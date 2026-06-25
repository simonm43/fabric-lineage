/**
 * Small formatting / coercion helpers.
 */

/** Short display label for a dataset/table name (drops namespace prefixes). */
export function shortLabel(name: string): string {
  const s = (name || '').trim();
  if (!s) return s;
  const slash = s.split('/').pop() ?? s;
  const dot = slash.split('.').pop() ?? slash;
  return dot || slash || s;
}

/** Coerce an arbitrary cell value to a non-negative integer (NaN → 0). */
export function toCount(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

/** Parse a Kusto/SQL datetime value to an ISO string, or undefined. */
export function toDate(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Human "time ago" string for a date/ISO value. */
export function timeAgo(value: unknown): string {
  const iso = toDate(value);
  if (!iso) return '';
  const then = new Date(iso).getTime();
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * Absolute local date+time for a date/ISO value (e.g. "Jun 24, 2026, 1:05 PM").
 * Returns '' when the value is not a valid date.
 */
export function formatDateTime(value: unknown): string {
  const iso = toDate(value);
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Best-effort message extraction for token/auth errors. */
export function authErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  try {
    const s = JSON.stringify(error);
    if (s && s !== '{}') return s;
  } catch {
    /* ignore */
  }
  return String(error);
}
