/**
 * contractExpiry.ts
 *
 * Utility to detect whether a Kite futures/options instrument symbol has
 * passed its expiry date, purely from the symbol string — no DB lookup needed.
 *
 * Kite monthly futures naming convention:
 *   MCX:CRUDEOIL26JULFUT  → expires in Jul 2026
 *   CDS:USDINR26JULFUT    → expires in Jul 2026
 *   NSE:NIFTY2630JAN25FUT → expires 30 Jan 2025  (weekly/monthly NFO)
 *
 * The parser extracts a year+month (or year+month+day for weekly) and compares
 * against today's date.  If the expiry month+year is strictly before today,
 * the contract is considered expired.
 */

const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

/**
 * Try to extract an expiry date from a Kite instrument symbol.
 * Returns a Date set to the first day of the expiry month, or null if the
 * symbol doesn't look like an expiring futures/options contract.
 */
export function parseContractExpiry(kiteSymbol: string): Date | null {
  // Strip exchange prefix: "MCX:CRUDEOIL26JULFUT" → "CRUDEOIL26JULFUT"
  const sym = kiteSymbol.includes(':') ? kiteSymbol.split(':')[1] : kiteSymbol;

  // Match patterns like 26JUL, 26AUG, 26JAN, etc. (YY + MON)
  // e.g. CRUDEOIL26JULFUT, USDINR26JULFUT, GOLD26AUGFUT
  const monthlyMatch = sym.match(/(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(FUT|CE|PE)/i);
  if (monthlyMatch) {
    const year = 2000 + parseInt(monthlyMatch[1], 10);
    const month = MONTH_MAP[monthlyMatch[2].toUpperCase()];
    // A contract is active through the end of its expiry month.
    // Expired = current month is strictly after expiry month.
    return new Date(year, month, 1); // first of expiry month
  }

  // Weekly NFO pattern: NIFTY2630JAN25FUT or BANKNIFTY2623JAN25PE
  // Format: SYMBOL + YY + DD + MON + YY (different year encoding)
  const weeklyMatch = sym.match(/\d{2}(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(FUT|CE|PE)/i);
  if (weeklyMatch) {
    const day = parseInt(weeklyMatch[1], 10);
    const month = MONTH_MAP[weeklyMatch[2].toUpperCase()];
    const year = 2000 + parseInt(weeklyMatch[3], 10);
    return new Date(year, month, day);
  }

  return null;
}

/**
 * Returns true if the instrument has passed its expiry.
 * Perpetual/equity/index symbols (no date in name) always return false.
 *
 * Heuristic for same-expiry-month contracts: MCX commodities typically
 * expire around the 17th–20th of the month, and CDS contracts expire on
 * the last Friday.  We consider a contract expired once we are past the
 * 20th of the expiry month — this catches MCX expirations on time while
 * keeping CDS/NSE contracts alive until month-end.
 */
export function isContractExpired(kiteSymbol: string): boolean {
  const expiry = parseContractExpiry(kiteSymbol);
  if (!expiry) return false;

  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth();
  const todayDate = today.getDate();

  const expiryYear = expiry.getFullYear();
  const expiryMonth = expiry.getMonth();

  // Definitely expired once we are in a later month/year
  if (expiryYear < todayYear) return true;
  if (expiryYear === todayYear && expiryMonth < todayMonth) return true;

  // Same-month expiry handling for MCX contracts
  if (expiryYear === todayYear && expiryMonth === todayMonth) {
    const sym = kiteSymbol.toUpperCase();
    if (sym.includes('SILVER') && !sym.includes('SILVERM') && todayDate > 4) {
      return true;
    }
    if (sym.includes('GOLD') && todayDate > 5) {
      return true;
    }
    if (sym.includes('CRUDEOIL') && todayDate > 21) {
      return true;
    }
    if (sym.includes('NATURALGAS') && todayDate > 26) {
      return true;
    }
  }

  return false;
}

const MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Generates the current active monthly futures symbol for a given prefix and base.
 * e.g. prefix="CDS", base="USDINR" → "CDS:USDINR26SEPFUT" (for Sep 2026)
 * Handles non-standard MCX commodity contract cycles (e.g. bimonthly Gold, quarterly Silver).
 */
export function getCurrentFuturesSymbol(prefix: string, base: string, date = new Date()): string {
  const cleanPrefix = prefix.toUpperCase().trim();
  const cleanBase = base.toUpperCase().trim();
  const yy = String(date.getFullYear()).slice(-2);
  const month = date.getMonth(); // 0 = JAN, 8 = SEP
  const day = date.getDate();

  if (cleanPrefix === 'MCX') {
    if (cleanBase === 'GOLD') {
      // Gold bi-monthly: FEB (1), APR (3), JUN (5), AUG (7), OCT (9), DEC (11)
      const goldMonths = [1, 3, 5, 7, 9, 11];
      let targetMonth = goldMonths.find(m => m > month || (m === month && day <= 5));
      let targetYear = yy;
      if (targetMonth === undefined) {
        targetMonth = goldMonths[0]; // FEB next year
        targetYear = String(date.getFullYear() + 1).slice(-2);
      }
      return `MCX:GOLD${targetYear}${MONTH_CODES[targetMonth]}FUT`;
    }
    if (cleanBase === 'GOLDM') {
      const goldmMonths = [1, 3, 5, 7, 9, 11];
      let targetMonth = goldmMonths.find(m => m > month || (m === month && day <= 5));
      let targetYear = yy;
      if (targetMonth === undefined) {
        targetMonth = goldmMonths[0];
        targetYear = String(date.getFullYear() + 1).slice(-2);
      }
      return `MCX:GOLDM${targetYear}${MONTH_CODES[targetMonth]}FUT`;
    }
    if (cleanBase === 'SILVER') {
      // Silver: MAR (2), MAY (4), JUL (6), SEP (8), DEC (11)
      // Expiry is around 4th-5th of month. After Sep 4, rolled to Dec contract.
      const silverMonths = [2, 4, 6, 8, 11];
      let targetMonth = silverMonths.find(m => m > month || (m === month && day <= 4));
      let targetYear = yy;
      if (targetMonth === undefined) {
        targetMonth = silverMonths[0]; // MAR next year
        targetYear = String(date.getFullYear() + 1).slice(-2);
      }
      return `MCX:SILVER${targetYear}${MONTH_CODES[targetMonth]}FUT`;
    }
    if (cleanBase === 'SILVERM') {
      // SilverM: FEB (1), APR (3), JUN (5), AUG (7), NOV (10)
      const silvermMonths = [1, 3, 5, 7, 10];
      let targetMonth = silvermMonths.find(m => m > month || (m === month && day <= 20));
      let targetYear = yy;
      if (targetMonth === undefined) {
        targetMonth = silvermMonths[0];
        targetYear = String(date.getFullYear() + 1).slice(-2);
      }
      return `MCX:SILVERM${targetYear}${MONTH_CODES[targetMonth]}FUT`;
    }
    if (cleanBase === 'CRUDEOIL') {
      const targetMonth = day > 19 ? (month + 1) % 12 : month;
      const targetYear = day > 19 && month === 11 ? String(date.getFullYear() + 1).slice(-2) : yy;
      return `MCX:CRUDEOIL${targetYear}${MONTH_CODES[targetMonth]}FUT`;
    }
    if (cleanBase === 'NATURALGAS') {
      const targetMonth = day > 25 ? (month + 1) % 12 : month;
      const targetYear = day > 25 && month === 11 ? String(date.getFullYear() + 1).slice(-2) : yy;
      return `MCX:NATURALGAS${targetYear}${MONTH_CODES[targetMonth]}FUT`;
    }
  }

  const mmm = MONTH_CODES[date.getMonth()];
  return `${prefix}:${base}${yy}${mmm}FUT`;
}

