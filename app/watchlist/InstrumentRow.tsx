'use client';

import React, { useState } from 'react';
import { QuoteData } from '@/hooks/useMarketQuotes';
import { ComexQuoteData } from '@/contexts/ComexDataContext';
import TickFlash from '@/components/TickFlash';
import { fmtSymbolName } from '@/lib/format';

export interface WatchlistItem {
  name: string;
  comexName?: string;
  symbol: string;
  kiteSymbol: string;
  binanceSymbol?: string;
  comexSymbol?: string;
  exchange?: string;
  price: number;
  change: string;
  segment: string;
  contractDate: string;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface InstrumentRowProps {
  item: WatchlistItem;
  quote?: QuoteData;
  binanceQuote?: QuoteData;
  comexQuote?: ComexQuoteData;
  onTrade: (item: WatchlistItem, side?: 'BUY' | 'SELL' | 'BOTH') => void;
  onDetail?: (item: WatchlistItem) => void;
  basketMode?: boolean;
  onBasketBuy?: (item: WatchlistItem) => void;
  onBasketSell?: (item: WatchlistItem) => void;
}

const CRYPTO_BASES = ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'];

function getExchangeBadge(segment: string, name?: string, symbol?: string): string {
  const segUpper = (segment || '').toUpperCase();
  const comb = `${name || ''} ${symbol || ''} ${segment || ''}`.toUpperCase();

  if (segUpper.includes('COMEX') || (symbol || '').toUpperCase().endsWith('=F')) return 'COMEX';

  const isCommodity = comb.includes('GOLD') || comb.includes('SILVER') || comb.includes('CRUDE') || comb.includes('NATGAS') || comb.includes('COPPER') || comb.includes('ZINC') || comb.includes('ALUM') || comb.includes('LEAD');
  const isOption = comb.includes(' CE') || comb.includes(' PE') || comb.endsWith('CE') || comb.endsWith('PE') || comb.includes('OPT');

  if (isCommodity) {
    if (isOption) return 'MCX-OPT';
    return 'MCX-FUT';
  }

  if (segUpper === 'STOCK-OPT' || segUpper.includes('STOCK OPTIONS') || segUpper.includes('STOCK OPT')) return 'STOCK-OPT';
  if (segUpper === 'STOCK-FUT' || segUpper.includes('STOCK FUTURES') || segUpper.includes('STOCK FUT')) return 'STOCK-FUT';
  if (segUpper === 'INDEX-OPT' || segUpper.includes('INDEX OPTIONS') || segUpper.includes('INDEX OPT')) return 'INDEX-OPT';
  if (segUpper === 'INDEX-FUT' || segUpper.includes('INDEX FUTURES') || segUpper.includes('INDEX FUT')) return 'INDEX-FUT';
  if (segUpper === 'MCX-OPT' || segUpper.includes('MCX OPTIONS')) return 'MCX-OPT';
  if (segUpper === 'MCX-FUT' || segUpper.includes('MCX FUTURES')) return 'MCX-FUT';

  // Symbol / Name based resolution if segment is generic (e.g. "NSE", "NFO", "BFO")
  const isIndex = comb.includes('NIFTY') || comb.includes('BANKNIFTY') || comb.includes('FINNIFTY') || comb.includes('SENSEX') || comb.includes('BANKEX') || comb.includes('MIDCP') || comb.includes('MIDCAP');
  const isFuture = comb.includes(' FUT') || comb.endsWith('FUT') || comb.includes('FUTURES');

  if (isOption) {
    if (isIndex) return segUpper.startsWith('BSE') || segUpper.startsWith('BFO') ? 'BFO' : 'NFO';
    if (segUpper.includes('MCX')) return 'MCX-OPT';
    return 'STOCK-OPT';
  }

  if (isFuture) {
    if (isIndex) return segUpper.startsWith('BSE') || segUpper.startsWith('BFO') ? 'BFO' : 'NFO';
    if (segUpper.includes('MCX')) return 'MCX-FUT';
    return 'STOCK-FUT';
  }

  if (segUpper.includes('MCX') || segUpper.includes('NCO')) return 'MCX';
  if (segUpper.includes('CRYPTO')) return 'CRYPTO';
  if (segUpper.includes('FOREX')) return 'FOREX';
  if (segUpper.includes('CDS')) return 'CDS';
  if (segUpper === 'NSE - EQUITY' || segUpper === 'NSE-EQ' || segUpper === 'EQUITY' || segUpper === 'NSE') return 'NSE';
  if (segUpper === 'BSE - EQUITY' || segUpper === 'BSE-EQ' || segUpper === 'BSE') return 'BSE';
  if (segUpper.startsWith('NSE') || segUpper.startsWith('NFO')) return 'NFO';
  if (segUpper.startsWith('BSE') || segUpper.startsWith('BFO')) return 'BFO';
  return 'NSE';
}

function getPctClass(pct: number) {
  return pct >= 0 ? 'pos' : 'neg';
}

export default function InstrumentRow({ item, quote, binanceQuote, comexQuote, onTrade }: InstrumentRowProps) {
  const [priceView, setPriceView] = useState<'kite' | 'comex'>('kite');

  const symUp = (item.symbol || '').toUpperCase().trim();
  const segUpper = (item.segment || '').toUpperCase();

  const isCrypto = !!item.binanceSymbol ||
                   segUpper === 'CRYPTO' ||
                   segUpper === 'CRYPTO-FUT' ||
                   symUp.endsWith('USDT') ||
                   CRYPTO_BASES.some(c => symUp === c || symUp.startsWith(`${c}USDT`) || symUp.startsWith(`${c}/`));

  const isCommoditySymbol = ['GOLD', 'SILVER', 'CRUDE', 'NATGAS', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUM'].some(c => symUp.includes(c));

  const isStock = !isCrypto && !isCommoditySymbol && (
    segUpper === 'STOCK-FUT' ||
    segUpper === 'STOCK-OPT' ||
    segUpper.includes('STOCK') ||
    segUpper.includes('STOCKS')
  );

  const hasDualView = !!item.kiteSymbol && !!item.comexSymbol;
  const showComex = hasDualView && priceView === 'comex';

  const activeCryptoQuote = quote || binanceQuote;

  let ltp = 0;
  let prevClose = 0;
  if (isCrypto) {
    ltp = activeCryptoQuote?.lastPrice ?? item.price ?? 0;
    prevClose = activeCryptoQuote?.close ?? item.close ?? ltp;
  } else if (showComex) {
    ltp = comexQuote?.lastPrice ?? 0;
    prevClose = comexQuote?.close ?? 0;
  } else {
    ltp = quote?.lastPrice ?? item.price;
    prevClose = item.close;
  }

  const absoluteChange = ltp - prevClose;
  const percentChange = prevClose !== 0 ? ((ltp - prevClose) / prevClose) * 100 : 0;
  const isLoading = isCrypto ? (!activeCryptoQuote && ltp === 0) : (showComex && !comexQuote);

  const handleCardClick = (e: React.MouseEvent) => {
    // If clicking a sub-button like delete or view toggle, don't trigger trade
    if ((e.target as HTMLElement).closest('.wc-action-btn') || (e.target as HTMLElement).closest('.dual-view-toggle')) {
      return;
    }
    onTrade({ ...item, preferredView: priceView } as any);
  };

  return (
    <div className="instr-row watchlist-card" data-symbol={item.symbol} onClick={handleCardClick} style={{ cursor: 'pointer' }}>
      <div className="wc-swipe-actions">
        <button className="wc-action-btn delete-btn" onClick={(e) => { e.stopPropagation(); (window as any).removeFromWatchlist?.(item.symbol); }}>
          <i className="fas fa-trash-alt"></i>
        </button>
      </div>
      <div className="wc-content instr-row__content">
        <div className="instr-row__left">
          <div className="instr-row__name-line">
            {(() => {
              const contractTag = (() => {
                if (item.contractDate) return item.contractDate;
                const sym = item.symbol || item.kiteSymbol || '';
                const m = sym.match(/(\d{2}[A-Z]{3})/i);
                return m ? m[1].toUpperCase() : '';
              })();

              const rawName = item.name || '';
              const isComex = item.segment?.includes('COMEX') || item.exchange === 'COMEX' || item.symbol?.endsWith('=F') || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => (item.symbol || '').includes(c) || (item.comexSymbol || '').includes(c));
              const isGenericCommodityName = !isComex && ['SILVER', 'GOLD', 'CRUDEOIL', 'COPPER', 'NATURALGAS', 'NATGAS'].includes(rawName.toUpperCase().trim());
              const baseName = isComex ? fmtSymbolName(item.symbol, item.name) : (isGenericCommodityName ? (item.symbol ? item.symbol.replace(/^(MCX|NSE|BSE|CDS|NFO|BFO):/, '') : rawName) : (rawName || item.symbol));

              const comexBaseName = comexQuote?.contractSymbol ?? item.comexName ?? baseName;
              const displayName = showComex
                ? (contractTag && !comexBaseName.toUpperCase().includes(contractTag.toUpperCase()) ? `${comexBaseName} (${contractTag})` : comexBaseName)
                : baseName;

              return <span className="instr-row__name">{displayName}</span>;
            })()}
            <span className="exchange-badge" style={
              isCrypto ? { background: '#F0A500', color: '#fff' } :
                showComex ? { background: '#4A148C', color: '#fff' } :
                  isStock ? { background: '#059669', color: '#fff' } : {}
            }>
              {isCrypto
                ? 'CRYPTO'
                : showComex
                  ? 'COMEX'
                  : isStock
                    ? (segUpper.includes('FUT') ? 'Stock - Stock Fut' : segUpper.includes('OPT') ? 'Stock - Stock Opt' : 'Stock')
                    : getExchangeBadge(item.segment, item.name, item.symbol)}
            </span>
          </div>
          {item.contractDate && (
            <div className="instr-row__date">{item.contractDate}</div>
          )}
          {isCrypto && (
            <div className="instr-row__date" style={{ color: '#6B7280', fontSize: '0.7rem' }}>{item.binanceSymbol}</div>
          )}
          {hasDualView && (
            <div
              className="dual-view-toggle"
              onClick={(e) => { e.stopPropagation(); setPriceView(v => v === 'kite' ? 'comex' : 'kite'); }}
              style={{ fontSize: '0.62rem', fontWeight: '700', color: showComex ? '#4A148C' : '#2C8E5A', background: showComex ? '#EDE7F6' : '#E9F6EF', padding: '2px 8px', borderRadius: '20px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', marginTop: '3px', userSelect: 'none' }}
            >
              {showComex ? '₹ COMEX ⇄ ₹ MCX' : '₹ MCX ⇄ ₹ COMEX'}
            </div>
          )}
        </div>
        <div className="instr-row__right">
          {isLoading ? (
            <div className="instr-row__ltp" style={{ color: '#9CA3AF' }}>Loading…</div>
          ) : (
            <>
              <div className="instr-row__ltp">
                <TickFlash value={ltp}>
                  {`₹${ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                </TickFlash>
              </div>
              <div className="instr-row__abs-change">
                <TickFlash value={absoluteChange}>
                  {absoluteChange >= 0 ? '+' : ''}{absoluteChange.toFixed(2)}
                </TickFlash>
              </div>
              <div className={`instr-row__pct-change ${getPctClass(percentChange)}`}>
                {percentChange >= 0 ? '+' : ''}{percentChange.toFixed(2)}%
              </div>
            </>
          )}
        </div>
        <div className="wc-checkbox-wrapper" style={{ display: 'none' }}>
          <input type="checkbox" className="wc-checkbox" onClick={(e) => e.stopPropagation()} />
        </div>
      </div>
    </div>
  );
}
