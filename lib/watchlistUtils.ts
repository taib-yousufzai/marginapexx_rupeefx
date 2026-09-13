export interface WatchlistLikeItem {
  name?: string;
  symbol?: string;
  kiteSymbol?: string;
  comexSymbol?: string;
  binanceSymbol?: string;
  segment?: string;
}

/**
 * Robustly checks whether an instrument is already present in a given watchlist.
 * Handles symbol aliases, group keys for commodities (GOLD/XAUUSD, SILVER/XAGUSD),
 * kite/comex/binance cross-references, and name matches.
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

  const getGroupKey = (sym: string, name: string, comex: string, kite: string) => {
    const combined = `${sym} ${name} ${comex} ${kite}`.toUpperCase();
    if (combined.includes('GOLD') || combined.includes('XAUUSD') || combined.includes('GC=F')) return 'GOLD';
    if (combined.includes('SILVER') || combined.includes('XAGUSD') || combined.includes('SI=F')) return 'SILVER';
    if (combined.includes('CRUDE') || combined.includes('XTIUSD') || combined.includes('CL=F')) return 'CRUDE';
    if (combined.includes('COPPER') || combined.includes('XCUUSD') || combined.includes('HG=F')) return 'COPPER';
    if (combined.includes('NATURAL') || combined.includes('NATGAS') || combined.includes('XNGUSD') || combined.includes('NG=F')) return 'NATGAS';
    return null;
  };

  const instGroupKey = getGroupKey(rawSym, rawName, rawComex, rawKite);

  return watchlistItems.some(i => {
    const iSym = (i.symbol || '').toUpperCase().trim();
    const iName = (i.name || '').toUpperCase().trim();
    const iKite = (i.kiteSymbol || '').toUpperCase().trim();
    const iComex = (i.comexSymbol || '').toUpperCase().trim();
    const iBinance = (i.binanceSymbol || '').toUpperCase().trim();

    if (instGroupKey) {
      const iGroupKey = getGroupKey(iSym, iName, iComex, iKite);
      if (iGroupKey && iGroupKey === instGroupKey) return true;
    }

    if (rawSym && (iSym === rawSym || iComex === rawSym || iKite === rawSym || iBinance === rawSym)) return true;
    if (rawName && iName === rawName) return true;
    if (rawKite && (iKite === rawKite || iSym === rawKite)) return true;
    if (rawComex && (iComex === rawComex || iSym === rawComex)) return true;
    if (rawBinance && (iBinance === rawBinance || iSym === rawBinance)) return true;

    return false;
  });
}
