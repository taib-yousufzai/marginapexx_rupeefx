export interface WatchlistLikeItem {
  name?: string;
  symbol?: string;
  kiteSymbol?: string;
  comexSymbol?: string;
  binanceSymbol?: string;
  segment?: string;
}

/**
 * Normalizes legacy Yahoo futures proxy tickers (CL=F, GC=F, SI=F, etc.) to clean COMEX spot symbols.
 */
export function normalizeComexTicker(sym: string): string {
  if (!sym || typeof sym !== 'string') return String(sym || '');
  const upper = sym.toUpperCase().trim();
  if (upper === 'CL=F' || upper === 'CL') return 'XTIUSD';
  if (upper === 'GC=F' || upper === 'GC') return 'XAUUSD';
  if (upper === 'SI=F' || upper === 'SI') return 'XAGUSD';
  if (upper === 'HG=F' || upper === 'HG') return 'XCUUSD';
  if (upper === 'NG=F' || upper === 'NG') return 'XNGUSD';
  return sym;
}

/**
 * Robustly checks whether an instrument is already present in a given watchlist.
 * Handles exact symbol matches, specific datafeed identifiers (kite, binance, comex),
 * and segment-safe name matches without incorrectly collapsing MCX and COMEX commodities.
 */
export function isInstrumentInWatchlist(
  inst: WatchlistLikeItem,
  watchlistItems: WatchlistLikeItem[]
): boolean {
  if (!inst || !watchlistItems || watchlistItems.length === 0) return false;

  const rawSym = (inst.symbol || '').toUpperCase().trim();
  const rawName = (inst.name || '').toUpperCase().trim();
  const rawKite = (inst.kiteSymbol || '').toUpperCase().trim();
  const rawComex = (inst.comexSymbol || '').toUpperCase().trim();
  const rawBinance = (inst.binanceSymbol || '').toUpperCase().trim();
  const rawSeg = (inst.segment || '').toUpperCase().trim();

  const isComexInst = rawSeg.includes('COMEX') || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].includes(rawSym);
  const isMcxInst = rawSeg.includes('MCX') || rawKite.startsWith('MCX:') || rawSym.endsWith('_FUT') || rawSym.endsWith('_OPT');

  return watchlistItems.some(i => {
    const iSym = (i.symbol || '').toUpperCase().trim();
    const iName = (i.name || '').toUpperCase().trim();
    const iKite = (i.kiteSymbol || '').toUpperCase().trim();
    const iComex = (i.comexSymbol || '').toUpperCase().trim();
    const iBinance = (i.binanceSymbol || '').toUpperCase().trim();
    const iSeg = (i.segment || '').toUpperCase().trim();

    const isComexI = iSeg.includes('COMEX') || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].includes(iSym);
    const isMcxI = iSeg.includes('MCX') || iKite.startsWith('MCX:') || iSym.endsWith('_FUT') || iSym.endsWith('_OPT');

    // Never cross-match MCX and COMEX instruments
    if (isMcxInst && isComexI) return false;
    if (isComexInst && isMcxI) return false;

    // 1. Direct symbol match
    if (rawSym && iSym && rawSym === iSym) return true;

    // 2. Specific data feed identifier matches
    if (rawKite && iKite && rawKite === iKite) return true;
    if (rawBinance && iBinance && rawBinance === iBinance) return true;
    if (rawComex && iComex && rawComex === iComex && isComexInst && isComexI) return true;

    // 3. Exact name match within compatible market segments
    if (rawName && iName && rawName === iName) {
      if (isComexInst === isComexI && isMcxInst === isMcxI) {
        return true;
      }
    }

    return false;
  });
}
