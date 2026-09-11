/**
 * lib/format.ts — canonical display formatters for the whole app.
 *
 * Every component that previously defined its own local fmtPrice / fmtAmt /
 * fmtDate / … should import from here instead.
 *
 * Design rules:
 *   - All functions are pure (no side effects, no React deps).
 *   - Locale is always 'en-IN' for numeric formatting.
 *   - Null / undefined / NaN inputs return a safe fallback string, never throw.
 *   - No default exports — use named imports.
 */

// ─── Currency & Price ─────────────────────────────────────────────────────────

/**
 * Formats a number as an Indian-locale rupee amount with 2 decimal places.
 * Returns '—' for null / undefined / NaN.
 *
 * @example fmtCurrency(123456.78)  → '₹1,23,456.78'
 * @example fmtCurrency(null)       → '—'
 */
export function fmtCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return '—';
  return '₹' + value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formats a price — same as fmtCurrency but returns '--' on null/undefined
 * to match the trading UI convention (dashes instead of em-dash for prices).
 *
 * @example fmtPrice(105.50)  → '₹105.50'
 * @example fmtPrice(null)    → '--'
 */
export function fmtPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value as number)) return '--';
  return '₹' + value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formats a signed P&L value with an explicit +/- prefix.
 * Returns '—' for null / undefined / NaN.
 *
 * @example fmtPnl(1234.50)   → '+₹1,234.50'
 * @example fmtPnl(-500)      → '-₹500.00'
 * @example fmtPnl(0)         → '+₹0.00'
 */
export function fmtPnl(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return '—';
  const sign = value >= 0 ? '+' : '-';
  return sign + '₹' + Math.abs(value).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formats a plain numeric value with 2 decimal places (no ₹ prefix).
 * Returns '0.00' for null / undefined / NaN (matches admin-panel convention).
 *
 * @example fmtNum(42.5)   → '42.50'
 * @example fmtNum(null)   → '0.00'
 */
export function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value as number)) return '0.00';
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// ─── Percentage ───────────────────────────────────────────────────────────────

/**
 * Formats a percentage with an explicit +/- sign and 2 decimal places.
 *
 * @example fmtPercent(1.5)   → '+1.50%'
 * @example fmtPercent(-0.8)  → '-0.80%'
 */
export function fmtPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value as number)) return '0.00%';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// ─── Quantity ─────────────────────────────────────────────────────────────────

/**
 * Formats an integer quantity with Indian-locale thousand separators.
 * Decimals are stripped — quantities are always whole numbers in this app.
 *
 * @example fmtQty(12500)  → '12,500'
 */
export function fmtQty(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value as number)) return '0';
  return Math.round(value).toLocaleString('en-IN');
}

// ─── Compact / Balance ────────────────────────────────────────────────────────

/**
 * Compact balance display used in the trading header.
 * Shows 'k' suffix for values over 999, otherwise plain 2-dp number.
 * Returns '...' for null (loading state).
 *
 * @example fmtBalance(152300)  → '152.30k'
 * @example fmtBalance(850)     → '850.00'
 * @example fmtBalance(null)    → '...'
 */
export function fmtBalance(value: number | null | undefined): string {
  if (value === null || value === undefined) return '...';
  if (value > 999) return (value / 1000).toFixed(2) + 'k';
  return value.toFixed(2);
}

/**
 * Formats a number using Indian compact notation: k / L / Cr.
 * Useful for dashboard totals and admin summaries.
 *
 * @example fmtCompact(500)         → '500'
 * @example fmtCompact(12500)       → '12.5k'
 * @example fmtCompact(250000)      → '2.5L'
 * @example fmtCompact(15000000)    → '1.5Cr'
 */
export function fmtCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value as number)) return '0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10_000_000) return sign + (abs / 10_000_000).toFixed(2) + 'Cr';
  if (abs >= 100_000)    return sign + (abs / 100_000).toFixed(2) + 'L';
  if (abs >= 1_000)      return sign + (abs / 1_000).toFixed(2) + 'k';
  return sign + abs.toString();
}

// ─── Date & Time ──────────────────────────────────────────────────────────────

/**
 * Formats an ISO date string as a short date: '01 Jan 2025'.
 * Returns '—' for empty / invalid input.
 */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * Formats an ISO date string as time only: '09:30 AM'.
 * Returns '—' for empty / invalid input.
 */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

/**
 * Formats an ISO date string as a compact datetime: '01 Jan 25, 09:30'.
 * Used in order/trade history tables.
 * Returns '—' for empty / invalid input.
 */
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Formats an ISO date string as a full timestamp with seconds: '01 Jan 2025, 09:30:15 AM'.
 * Used in admin audit logs.
 * Returns '—' for empty / invalid input.
 */
export function fmtTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso ?? '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

/**
 * Formats a YYYY-MM-DD string as a human-readable contract expiry date.
 * Strips the time portion so the display is stable regardless of timezone.
 *
 * @example fmtExpiry('2025-06-26')  → '26 Jun 2025'
 * @example fmtExpiry(null)          → ''
 */
export function fmtExpiry(dateStr: string | null | undefined): string {
  if (!dateStr) return '';
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return dateStr;
  const [, year, month, day] = match;
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${parseInt(day, 10)} ${MONTHS[parseInt(month, 10) - 1]} ${year}`;
}

/**
 * Relative time string for notification / activity timestamps.
 *
 * @example timeAgo('2025-01-01T09:00:00Z')  → '5m ago' / '2h ago' / '3d ago'
 */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days  = Math.floor(diff / 86_400_000);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7)   return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

// ─── Duration ─────────────────────────────────────────────────────────────────

/**
 * Formats a duration in seconds as 'MM m SS s'.
 * Used for hold-lock countdown display.
 *
 * @example fmtHoldTime(125)  → '02m 05s'
 */
export function fmtHoldTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

/**
 * Formats a duration in seconds as 'Xh Ym Zs'.
 * Used in admin reports.
 *
 * @example fmtDuration(3725)  → '1h 2m 5s'
 */
export function fmtDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

// ─── Symbol & Instrument Formatting ──────────────────────────────────────────

const COMEX_SYMBOL_MAP: Record<string, string> = {
  'GC=F': 'GOLD',
  'GC': 'GOLD',
  'SI=F': 'SILVER',
  'SI': 'SILVER',
  'CL=F': 'CRUDE OIL',
  'CL': 'CRUDE OIL',
  'HG=F': 'COPPER',
  'HG': 'COPPER',
  'NG=F': 'NATURAL GAS',
  'NG': 'NATURAL GAS',
  'PL=F': 'PLATINUM',
  'PL': 'PLATINUM',
  'PA=F': 'PALLADIUM',
  'PA': 'PALLADIUM',
  'NQ=F': 'NASDAQ',
  'NQ': 'NASDAQ',
  'ES=F': 'S&P 500',
  'ES': 'S&P 500',
  'YM=F': 'DOW',
  'YM': 'DOW',
};

/**
 * Returns a clean display name for a trading instrument.
 * Maps COMEX proxy ticker symbols (e.g. 'GC=F', 'SI=F', 'CL=F') to readable names ('GOLD', 'SILVER', 'CRUDE OIL').
 */
export function fmtSymbolName(symbol: string | null | undefined, name?: string | null): string {
  if (!symbol && !name) return '—';
  const symClean = (symbol || '').trim();
  const symUpper = symClean.toUpperCase();

  if (COMEX_SYMBOL_MAP[symUpper]) {
    return COMEX_SYMBOL_MAP[symUpper];
  }

  const rawTicker = symUpper.split(':').pop() || '';
  if (COMEX_SYMBOL_MAP[rawTicker]) {
    return COMEX_SYMBOL_MAP[rawTicker];
  }

  if (name && name !== symbol && !name.endsWith('=F') && !name.includes('=F')) {
    return name;
  }

  return symClean || name || '—';
}
