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
  if (expiryYear === todayYear && expiryMonth === todayMonth) {
    const symUpper = kiteSymbol.toUpperCase();
    if (symUpper.includes('GOLD') || symUpper.includes('SILVER')) {
      if (todayDate >= 5) return true;
    } else if (symUpper.includes('CRUDEOIL')) {
      if (todayDate >= 18) return true;
    } else if (symUpper.includes('NATURALGAS') || symUpper.includes('NATGAS')) {
      if (todayDate >= 24) return true;
    } else if (symUpper.includes('USDINR')) {
      if (todayDate >= 26) return true;
    } else if (todayDate >= 20) {
      return true;
    }
  }

  return false;
}

const MONTH_CODES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Generates the current active monthly futures symbol for a given prefix and base.
 * Handles bimonthly/quarterly cycles for MCX Gold/Silver and post-rollover dates for Crude/NatGas/CDS.
 * e.g. in late Sep 2026:
 *   prefix="MCX", base="GOLD" → "MCX:GOLD26OCTFUT"
 *   prefix="MCX", base="SILVER" → "MCX:SILVER26DECFUT"
 *   prefix="MCX", base="CRUDEOIL" → "MCX:CRUDEOIL26OCTFUT"
 *   prefix="CDS", base="USDINR" → "CDS:USDINR26OCTFUT"
 */
export function getCurrentFuturesSymbol(prefix: string, base: string, date = new Date()): string {
  const targetDate = new Date(date);
  const day = targetDate.getDate();
  const month = targetDate.getMonth();
  const baseUpper = base.toUpperCase();

  if (prefix === 'MCX') {
    if (baseUpper === 'SILVER' || baseUpper === 'SILVERM') {
      // Silver cycle: MAR, MAY, JUL, SEP, DEC (months 2, 4, 6, 8, 11)
      const silverMonths = [2, 4, 6, 8, 11];
      let activeMonth = silverMonths.find(m => m > month || (m === month && day < 5));
      if (activeMonth === undefined) {
        targetDate.setFullYear(targetDate.getFullYear() + 1);
        activeMonth = 2; // March next year
      }
      targetDate.setMonth(activeMonth);
    } else if (baseUpper === 'GOLD' || baseUpper === 'GOLDM') {
      // Gold cycle: FEB, APR, JUN, AUG, OCT, DEC (months 1, 3, 5, 7, 9, 11)
      const goldMonths = [1, 3, 5, 7, 9, 11];
      let activeMonth = goldMonths.find(m => m > month || (m === month && day < 5));
      if (activeMonth === undefined) {
        targetDate.setFullYear(targetDate.getFullYear() + 1);
        activeMonth = 1; // Feb next year
      }
      targetDate.setMonth(activeMonth);
    } else {
      // Crude Oil / Natural Gas: monthly expiry around 18th-20th
      if (day >= 18) {
        targetDate.setMonth(month + 1);
      }
    }
  } else if (prefix === 'CDS') {
    // CDS expires on last Friday/26th of the month
    if (day >= 26) {
      targetDate.setMonth(month + 1);
    }
  }

  const yy = String(targetDate.getFullYear()).slice(-2);
  const mmm = MONTH_CODES[targetDate.getMonth()];
  return `${prefix}:${base}${yy}${mmm}FUT`;
}

