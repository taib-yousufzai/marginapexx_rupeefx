import { getAdminClient } from '@/lib/adminClient';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import { fetchSpeedQuotes, fetchKiteQuotes } from '@/lib/datafeed/MarketDataService';
import { getCenteredStrikeWindow } from '@/lib/trading/optionStrikeWindow';

export interface StrikeValidationResult {
  allowed: boolean;
  orderStrike: number;
  minAllowed: number;
  maxAllowed: number;
  reason?: string;
}

export const MCX_UNDERLYINGS = new Set([
  'GOLD', 'GOLDM', 'SILVER', 'SILVERM', 'SILVERMIC',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI',
  'COPPER', 'ZINC', 'ZINCMINI', 'LEAD', 'LEADMINI',
  'ALUMINIUM', 'ALUMINI',
]);

const MCX_BASE_MAP: Record<string, string> = {
  'GOLDM': 'GOLD', 'SILVERM': 'SILVER', 'SILVERMIC': 'SILVER',
  'CRUDEOILM': 'CRUDEOIL', 'NATGASMINI': 'NATURALGAS',
  'ALUMINI': 'ALUMINIUM', 'ZINCMINI': 'ZINC', 'LEADMINI': 'LEAD',
};

const INDEX_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'NIFTYFPI']);
const BSE_INDEX_UNDERLYINGS = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

/**
 * Resolves the target exchange for a given option symbol or underlying name.
 */
export function resolveTargetExchange(symbol: string, underlying: string): string {
  if (symbol.includes(':')) {
    const prefix = symbol.split(':')[0].toUpperCase();
    if (prefix === 'NSE') return 'NFO';
    if (prefix === 'BSE') return 'BFO';
    return prefix;
  }
  const undUpper = underlying.toUpperCase();
  if (MCX_UNDERLYINGS.has(undUpper)) return 'MCX';
  if (BSE_INDEX_UNDERLYINGS.has(undUpper)) return 'BFO';
  if (INDEX_UNDERLYINGS.has(undUpper)) return 'NFO';
  return 'NFO';
}

/**
 * Resolves the underlying Kite instrument key for an option symbol.
 */
export async function resolveUnderlyingKiteId(symbol: string, underlying: string): Promise<string> {
  const undUpper = underlying.toUpperCase();
  const isMcx = MCX_UNDERLYINGS.has(undUpper);

  if (isMcx) {
    const baseName = MCX_BASE_MAP[undUpper] || undUpper;
    const admin = getAdminClient();
    const today = new Date().toISOString().split('T')[0];

    const { data: mcxFuts } = await admin
      .from('instruments')
      .select('tradingsymbol, exchange')
      .eq('name', baseName)
      .eq('segment', 'MCX-FUT')
      .gte('expiry', today)
      .order('expiry', { ascending: true })
      .limit(1);

    if (mcxFuts?.[0]?.tradingsymbol) {
      return `${mcxFuts[0].exchange || 'MCX'}:${mcxFuts[0].tradingsymbol}`;
    }
    return `MCX:${baseName}`;
  }

  if (undUpper === 'BANKNIFTY') return 'NSE:NIFTY BANK';
  if (undUpper === 'FINNIFTY') return 'NSE:NIFTY FIN SERVICE';
  if (undUpper === 'SENSEX') return 'BSE:SENSEX';
  if (undUpper === 'SENSEX50') return 'BSE:SENSEX50';
  if (undUpper === 'BANKEX') return 'BSE:BANKEX';
  if (undUpper === 'MIDCPNIFTY') return 'NSE:NIFTY MID SELECT';
  if (undUpper === 'NIFTYNXT50') return 'NSE:NIFTY NEXT 50';
  if (undUpper === 'NIFTY') return 'NSE:NIFTY 50';
  return `NSE:${undUpper}`;
}

/**
 * Validates an option order strike price strictly against exact membership in the active 11-strike option-chain window.
 */
export async function validateOptionStrike(params: {
  symbol: string;
  isExit?: boolean;
  exchange?: string;
  knownQuotesMap?: Record<string, any>;
}): Promise<StrikeValidationResult> {
  const { symbol, isExit, exchange: paramExchange, knownQuotesMap } = params;

  // Exit orders always bypass strike range validation
  if (isExit) {
    return { allowed: true, orderStrike: 0, minAllowed: 0, maxAllowed: 0 };
  }

  const parsed = parseOptionSymbol(symbol);
  if (!parsed || parsed.strike <= 0) {
    return { allowed: true, orderStrike: 0, minAllowed: 0, maxAllowed: 0 };
  }

  const { underlying, strike: orderStrike } = parsed;
  const admin = getAdminClient();
  const cleanSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const targetExchange = paramExchange || resolveTargetExchange(symbol, underlying);

  const allowedExchanges = (targetExchange === 'MCX')
    ? ['MCX']
    : (targetExchange === 'NCO')
    ? ['NCO']
    : (targetExchange === 'NFO' || targetExchange === 'NSE')
    ? ['NFO', 'NSE']
    : (targetExchange === 'BFO' || targetExchange === 'BSE')
    ? ['BFO', 'BSE']
    : [targetExchange];

  // 1. Fetch contract instrument row filtering by exact exchange to prevent NCO/MCX collision
  let query = admin
    .from('instruments')
    .select('name, expiry, exchange')
    .or(`tradingsymbol.eq.${cleanSymbol},tradingsymbol.eq.${symbol},tradingsymbol.eq.${targetExchange}:${cleanSymbol}`);

  if (targetExchange) {
    query = query.in('exchange', allowedExchanges);
  }

  const { data: instrRow } = await query.order('exchange', { ascending: true }).limit(1).maybeSingle();

  if (!instrRow?.expiry) {
    // Fail open if instrument details cannot be found
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  // 2. Fetch sibling contract strikes for the exact underlying, expiry, and exchange
  const { data: siblingRows } = await admin
    .from('instruments')
    .select('strike_price')
    .eq('name', instrRow.name || underlying)
    .eq('expiry', instrRow.expiry)
    .in('exchange', allowedExchanges)
    .in('option_type', ['CE', 'PE']);

  if (!siblingRows || siblingRows.length === 0) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  const rawStrikes = siblingRows.map(s => ({ strike: Number(s.strike_price) })).filter(s => s.strike > 0);
  const strikeMap = new Map<number, { strike: number }>();
  rawStrikes.forEach(s => strikeMap.set(s.strike, s));
  const sortedStrikes = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

  if (sortedStrikes.length === 0) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  // 3. Resolve live spot price
  const underlyingKiteId = await resolveUnderlyingKiteId(symbol, underlying);
  const baseSymbol = underlying.toUpperCase();
  const mcxBase = MCX_BASE_MAP[baseSymbol] || baseSymbol;

  const candidateKeys = Array.from(new Set([
    underlyingKiteId,
    `MCX:${mcxBase}`,
    `MCX:${baseSymbol}`,
    `NSE:${baseSymbol}`,
    `NSE:${baseSymbol} 50`,
    baseSymbol,
  ]));

  let underlyingPrice = 0;
  if (knownQuotesMap) {
    for (const key of candidateKeys) {
      const raw = knownQuotesMap[key];
      if (raw !== undefined) {
        const val = typeof raw === 'number' ? raw : (raw?.last_price ?? raw?.lastPrice ?? raw?.ltp ?? 0);
        if (typeof val === 'number' && val > 0) {
          underlyingPrice = val;
          break;
        }
      }
    }
  }

  if (!underlyingPrice || underlyingPrice <= 0) {
    try {
      const speedMap = await fetchSpeedQuotes([underlyingKiteId, `MCX:${mcxBase}`, `NSE:${baseSymbol}`]);
      underlyingPrice = speedMap?.[underlyingKiteId] || speedMap?.[`NSE:${baseSymbol}`] || speedMap?.[`MCX:${mcxBase}`] || 0;
    } catch { /* ignore */ }
  }

  if (!underlyingPrice || underlyingPrice <= 0) {
    try {
      const restMap = await fetchKiteQuotes([underlyingKiteId, `MCX:${mcxBase}`, `NSE:${baseSymbol}`]);
      underlyingPrice = restMap?.[underlyingKiteId] || restMap?.[`NSE:${baseSymbol}`] || restMap?.[`MCX:${mcxBase}`] || 0;
    } catch { /* ignore */ }
  }

  // FAIL OPEN: If live spot price cannot be retrieved (> 0), do not block valid trades if quote stream is down
  if (!underlyingPrice || underlyingPrice <= 0 || isNaN(underlyingPrice)) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }


  // 4. Compute canonical 11-strike active option chain window using getCenteredStrikeWindow
  const { centeredStrikes } = getCenteredStrikeWindow(sortedStrikes, underlyingPrice);

  if (centeredStrikes.length === 0) {
    return { allowed: true, orderStrike, minAllowed: 0, maxAllowed: 0 };
  }

  const allowedStrikeValues = centeredStrikes.map(s => s.strike);
  const minVisible = allowedStrikeValues[0];
  const maxVisible = allowedStrikeValues[allowedStrikeValues.length - 1];

  // 5. Membership validation (STRICT SET INCLUSION)
  const isAllowed = allowedStrikeValues.includes(orderStrike);

  if (isAllowed) {
    return { allowed: true, orderStrike, minAllowed: minVisible, maxAllowed: maxVisible };
  }

  return {
    allowed: false,
    orderStrike,
    minAllowed: minVisible,
    maxAllowed: maxVisible,
    reason: `Strike price ${orderStrike} is outside the active option chain window (${minVisible} to ${maxVisible}).`,
  };
}
