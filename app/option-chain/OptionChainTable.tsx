'use client';

import React from 'react';
import { QuoteData } from '@/hooks/useMarketQuotes';

interface StrikeData {
  strike: number;
  ce?: { token: number; symbol: string; id: string; price?: number };
  pe?: { token: number; symbol: string; id: string; price?: number };
}

interface OptionChainTableProps {
  strikes: StrikeData[];
  quotes: Record<string, QuoteData>;
  spotPrice: number;
  symbol?: string;
  onTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  onOpenChart?: (symbol: string, kiteId?: string) => void;
  priceMode?: 'BA' | 'LTP';
  stickyTop?: number;
  hideMainHeader?: boolean;
  strikeRange?: number;
  loading?: boolean;
  bidBuffer?: number; // User's bid_buffer setting (e.g. 10 = 10 points or 10%)
  useLtpMode?: boolean; // If true, force B/A to be derived from LTP
}

import { getCenteredStrikeWindow } from '@/lib/trading/optionStrikeWindow';
export { getCenteredStrikeWindow };

// ─── Skeleton row ─────────────────────────────────────────────────────────────
const SkeletonRow = React.memo(function SkeletonRow({ isCenter }: { isCenter: boolean }) {
  const pulse: React.CSSProperties = {
    background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
    backgroundSize: '200% 100%',
    animation: 'oc-pulse 1.4s ease-in-out infinite',
    borderRadius: 4,
    height: 14,
  };
  const rowStyle: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
    borderBottom: isCenter ? '2px solid rgba(198,46,46,0.4)' : '1px solid #f0f2f5',
    borderTop: isCenter ? '2px solid rgba(198,46,46,0.4)' : undefined,
    flexShrink: 0,
  };
  const cellBase: React.CSSProperties = {
    display: 'flex', justifyContent: 'space-around', alignItems: 'center', padding: '12px 10px', gap: 8,
  };
  return (
    <div style={rowStyle}>
      <div style={{ ...cellBase, background: '#f4fbf4' }}>
        <div style={{ ...pulse, width: '38%' }} />
        <div style={{ ...pulse, width: '38%' }} />
      </div>
      <div style={{ ...cellBase, background: '#fefef8', justifyContent: 'center' }}>
        <div style={{ ...pulse, width: '60%' }} />
      </div>
      <div style={{ ...cellBase, background: '#fff7f3' }}>
        <div style={{ ...pulse, width: '38%' }} />
        <div style={{ ...pulse, width: '38%' }} />
      </div>
    </div>
  );
});

// ─── Memoized live row ────────────────────────────────────────────────────────
interface StrikeRowProps {
  strike: number;
  ceSymbol?: string; ceStaticPrice?: number; ceQuote: QuoteData | null; ceId?: string;
  peSymbol?: string; peStaticPrice?: number; peQuote: QuoteData | null; peId?: string;
  isAtm: boolean;
  atmRef: React.RefObject<HTMLDivElement | null>;
  priceMode: 'BA' | 'LTP';
  onTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  onOpenChart?: (symbol: string, kiteId?: string) => void;
  bidBuffer?: number;
  useLtpMode?: boolean;
}

// Apply bid_buffer to compute synthetic spread:
// Matches TradeSheet logic: values > 0.005 are treated as percentages (e.g. 50 = 50%).
function applyBidBuffer(ltp: number, rawBid: number | null, rawAsk: number | null, bidBuffer: number): { bid: number; ask: number } {
  if (!ltp || ltp <= 0) return { bid: rawBid ?? 0, ask: rawAsk ?? 0 };
  if (!bidBuffer || bidBuffer <= 0) {
    return { bid: rawBid ?? ltp, ask: rawAsk ?? ltp };
  }

  const decimalBuffer = Math.abs(bidBuffer) > 0.005 ? bidBuffer / 100 : bidBuffer;
  const bufferAmount = Math.max(0.05, Math.round(ltp * decimalBuffer * 100) / 100);

  const bid = Math.max(0.05, Math.round((ltp - bufferAmount) * 100) / 100);
  const ask = Math.round((ltp + bufferAmount) * 100) / 100;

  return { bid, ask };
}

const StrikeRow = React.memo(function StrikeRow({
  strike, ceSymbol, ceStaticPrice, ceQuote, ceId,
  peSymbol, peStaticPrice, peQuote, peId,
  isAtm, atmRef, priceMode, onTrade, onOpenChart, bidBuffer = 0, useLtpMode = false,
}: StrikeRowProps) {
  const ceLtpVal = ceQuote?.lastPrice ?? ceStaticPrice;
  const peLtpVal = peQuote?.lastPrice ?? peStaticPrice;

  // When useLtpMode is true OR bidBuffer > 0, force synthetic bid/ask from LTP.
  // When useLtpMode is false AND bidBuffer = 0, use raw exchange bid/ask if available.
  const forceSynthetic = useLtpMode || bidBuffer > 0;
  
  const { bid: ceBidFinal, ask: ceAskFinal } = forceSynthetic && ceLtpVal
    ? applyBidBuffer(ceLtpVal, null, null, bidBuffer)
    : { bid: ceQuote?.bid && ceQuote.bid > 0 ? ceQuote.bid : null, ask: ceQuote?.ask && ceQuote.ask > 0 ? ceQuote.ask : null };

  const { bid: peBidFinal, ask: peAskFinal } = forceSynthetic && peLtpVal
    ? applyBidBuffer(peLtpVal, null, null, bidBuffer)
    : { bid: peQuote?.bid && peQuote.bid > 0 ? peQuote.bid : null, ask: peQuote?.ask && peQuote.ask > 0 ? peQuote.ask : null };

  const ceHasSpread = !!(ceBidFinal && ceAskFinal && ceBidFinal < ceAskFinal);
  const peHasSpread = !!(peBidFinal && peAskFinal && peBidFinal < peAskFinal);

  const ceBid = ceBidFinal != null ? ceBidFinal.toFixed(1) : (ceLtpVal ? ceLtpVal.toFixed(1) : '---');
  const ceAsk = ceAskFinal != null ? ceAskFinal.toFixed(1) : (ceLtpVal ? ceLtpVal.toFixed(1) : '---');
  const peBid = peBidFinal != null ? peBidFinal.toFixed(1) : (peLtpVal ? peLtpVal.toFixed(1) : '---');
  const peAsk = peAskFinal != null ? peAskFinal.toFixed(1) : (peLtpVal ? peLtpVal.toFixed(1) : '---');
  const ceLtp = ceLtpVal ? `₹${ceLtpVal.toFixed(1)}` : '---';
  const peLtp = peLtpVal ? `₹${peLtpVal.toFixed(1)}` : '---';

  const click = (e: React.MouseEvent, sym?: string, side?: 'BUY' | 'SELL') => {
    e.stopPropagation();
    if (sym && side) onTrade(sym, side);
  };

  const openChart = (e: React.MouseEvent, sym?: string, kiteId?: string) => {
    e.stopPropagation();
    if (sym && onOpenChart) onOpenChart(sym, kiteId);
  };

  const showHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const h = e.currentTarget.querySelector<HTMLElement>('.oc-ha');
    if (h) { h.style.opacity = '1'; h.style.pointerEvents = 'auto'; }
  };
  const hideHover = (e: React.MouseEvent<HTMLDivElement>) => {
    const h = e.currentTarget.querySelector<HTMLElement>('.oc-ha');
    if (h) { h.style.opacity = '0'; h.style.pointerEvents = 'none'; }
  };

  const ROW: React.CSSProperties = {
    display: 'grid', gridTemplateColumns: '1fr 1fr 1fr',
    borderBottom: isAtm ? '2px solid rgba(198,46,46,0.5)' : '1px solid #f0f2f5',
    borderTop: isAtm ? '2px solid rgba(198,46,46,0.5)' : undefined,
    flexShrink: 0,
  };
  const CALL: React.CSSProperties = {
    position: 'relative', background: '#f4fbf4', overflow: 'hidden',
    display: 'flex', justifyContent: 'space-around', alignItems: 'center',
    padding: '11px 8px', cursor: 'pointer', gap: 4,
  };
  const STR: React.CSSProperties = {
    background: isAtm ? '#fff8f0' : '#fefef8',
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '11px 4px',
  };
  const PUT: React.CSSProperties = {
    position: 'relative', background: '#fff7f3', overflow: 'hidden',
    display: 'flex', justifyContent: 'space-around', alignItems: 'center',
    padding: '11px 8px', cursor: 'pointer', gap: 4,
  };
  const VAL: React.CSSProperties = { fontSize: 14, fontWeight: 700, color: '#1e293b', fontFamily: 'Inter,sans-serif' };
  const SVAL: React.CSSProperties = { fontSize: 14, fontWeight: isAtm ? 800 : 700, color: '#C62E2E', fontFamily: 'Inter,sans-serif' };
  const HOVER: React.CSSProperties = {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    background: 'rgba(255,255,255,0.95)', opacity: 0, pointerEvents: 'none', transition: 'opacity 0.15s',
  };
  const BTN_B: React.CSSProperties = { width: 28, height: 28, borderRadius: 4, border: 'none', fontSize: 11, fontWeight: 800, color: '#fff', cursor: 'pointer', background: '#12B76A' };
  const BTN_S: React.CSSProperties = { ...BTN_B, background: '#F04438' };
  const BTN_C: React.CSSProperties = { ...BTN_B, background: '#2563EB', fontSize: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' };

  return (
    <div ref={isAtm ? atmRef : null} style={ROW}>
      <div style={CALL} onClick={(e) => click(e, ceSymbol, 'BUY')} onMouseEnter={showHover} onMouseLeave={hideHover}>
        {priceMode === 'BA'
          ? <><span style={VAL}>{ceBid}</span><span style={VAL}>{ceAsk}</span></>
          : <span style={VAL}>{ceLtp}</span>}
        {ceSymbol && <div className="oc-ha" style={HOVER}>
          <button style={BTN_B} onClick={(e) => click(e, ceSymbol, 'BUY')}>B</button>
          <button style={BTN_S} onClick={(e) => click(e, ceSymbol, 'SELL')}>S</button>
          {onOpenChart && <button style={BTN_C} onClick={(e) => openChart(e, ceSymbol, ceId)} title="Chart"><i className="fas fa-chart-line"></i></button>}
        </div>}
      </div>
      <div style={STR}>
        <span style={SVAL}>{strike.toLocaleString('en-IN')}</span>
      </div>
      <div style={PUT} onClick={(e) => click(e, peSymbol, 'BUY')} onMouseEnter={showHover} onMouseLeave={hideHover}>
        {priceMode === 'BA'
          ? <><span style={VAL}>{peBid}</span><span style={VAL}>{peAsk}</span></>
          : <span style={VAL}>{peLtp}</span>}
        {peSymbol && <div className="oc-ha" style={HOVER}>
          <button style={BTN_B} onClick={(e) => click(e, peSymbol, 'BUY')}>B</button>
          <button style={BTN_S} onClick={(e) => click(e, peSymbol, 'SELL')}>S</button>
          {onOpenChart && <button style={BTN_C} onClick={(e) => openChart(e, peSymbol, peId)} title="Chart"><i className="fas fa-chart-line"></i></button>}
        </div>}
      </div>
    </div>
  );
}, (prev, next) => {
  if (prev.strike !== next.strike || prev.ceSymbol !== next.ceSymbol || prev.peSymbol !== next.peSymbol) return false;
  if (prev.isAtm !== next.isAtm || prev.priceMode !== next.priceMode || prev.bidBuffer !== next.bidBuffer || prev.useLtpMode !== next.useLtpMode) return false;
  const cq = [prev.ceQuote, next.ceQuote]; const pq = [prev.peQuote, next.peQuote];
  if (cq[0]?.lastPrice !== cq[1]?.lastPrice || cq[0]?.bid !== cq[1]?.bid || cq[0]?.ask !== cq[1]?.ask) return false;
  if (pq[0]?.lastPrice !== pq[1]?.lastPrice || pq[0]?.bid !== pq[1]?.bid || pq[0]?.ask !== pq[1]?.ask) return false;
  return true;
});

// ─── Main component ───────────────────────────────────────────────────────────

export default function OptionChainTable({
  strikes, quotes, spotPrice, symbol = '', onTrade, onOpenChart,
  priceMode = 'LTP', stickyTop = 58, hideMainHeader = false,
  strikeRange = 0, loading = false, bidBuffer = 0, useLtpMode = false,
}: OptionChainTableProps) {
  const atmRef = React.useRef<HTMLDivElement>(null);
  const tableHeaderRef = React.useRef<HTMLDivElement>(null);
  const tableBodyRef = React.useRef<HTMLDivElement>(null);
  const [subheadFloating, setSubheadFloating] = React.useState(false);

  const { centeredStrikes, atmIndex: centeredAtmIndex } = React.useMemo(() => {
    return getCenteredStrikeWindow(strikes, spotPrice);
  }, [strikes, spotPrice]);

  // Subheader floating
  React.useEffect(() => {
    const scrollEl = tableHeaderRef.current?.closest('.main-content') as HTMLElement | null;
    if (!scrollEl) return;
    const onScroll = () => {
      if (!tableHeaderRef.current) return;
      setSubheadFloating(tableHeaderRef.current.getBoundingClientRect().bottom <= stickyTop);
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', onScroll);
  }, [stickyTop]);

  const onTradeRef = React.useRef(onTrade);
  React.useEffect(() => { onTradeRef.current = onTrade; }, [onTrade]);
  const stableOnTrade = React.useCallback((sym: string, side: 'BUY' | 'SELL') => onTradeRef.current(sym, side), []);

  const getQuote = React.useCallback((id?: string, token?: number): QuoteData | null => {
    if (!id && !token) return null;
    if (id && quotes[id]) return quotes[id];
    if (token && quotes[String(token)]) return quotes[String(token)];
    if (id) {
      const parts = id.split(':');
      const exchange = parts.length > 1 ? parts[0] : null;
      const s = parts[parts.length - 1];
      if (s) {
        if (exchange && quotes[`${exchange}:${s}`]) return quotes[`${exchange}:${s}`];
        if (quotes[s]) return quotes[s];
      }
    }
    return null;
  }, [quotes]);

  const SKELETON_COUNT = 11;

  return (
    <div className="oct-wrap">
      <div className="oct-table">

        {!hideMainHeader && (
          <div className="oct-head" ref={tableHeaderRef}>
            <div className="oct-head-calls">{priceMode === 'LTP' ? 'CALL LTP' : 'CALLS'}</div>
            <div className="oct-head-strike">STRIKE</div>
            <div className="oct-head-puts">{priceMode === 'LTP' ? 'PUT LTP' : 'PUTS'}</div>
          </div>
        )}

        <div className={`oct-subhead${subheadFloating ? ' floating' : ''}`}>
          <div className="oct-sub-calls">
            {priceMode === 'BA' ? <><span>BID</span><span>ASK</span></> : <span>{hideMainHeader ? 'CALL' : 'LTP'}</span>}
          </div>
          <div className="oct-sub-strike">&#8377;</div>
          <div className="oct-sub-puts">
            {priceMode === 'BA' ? <><span>BID</span><span>ASK</span></> : <span>{hideMainHeader ? 'PUT' : 'LTP'}</span>}
          </div>
        </div>

        <div className="oct-body" ref={tableBodyRef}>
          {loading
            ? Array.from({ length: SKELETON_COUNT }, (_, i) => (
                <SkeletonRow key={i} isCenter={i === Math.floor(SKELETON_COUNT / 2)} />
              ))
            : centeredStrikes.map((s, index) => (
                <StrikeRow
                  key={`${s.strike}_${s.ce?.symbol || ''}_${s.pe?.symbol || ''}`}
                  strike={s.strike}
                  ceSymbol={s.ce?.symbol} ceStaticPrice={s.ce?.price} ceId={s.ce?.id}
                  peSymbol={s.pe?.symbol} peStaticPrice={s.pe?.price} peId={s.pe?.id}
                  ceQuote={getQuote(s.ce?.id, s.ce?.token)}
                  peQuote={getQuote(s.pe?.id, s.pe?.token)}
                  isAtm={index === centeredAtmIndex}
                  atmRef={atmRef}
                  priceMode={priceMode}
                  onTrade={stableOnTrade}
                  onOpenChart={onOpenChart}
                  bidBuffer={bidBuffer}
                  useLtpMode={useLtpMode}
                />
              ))
          }
        </div>
      </div>

      <style jsx>{`
        @keyframes oc-pulse {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }

        .oct-wrap { width: 100%; padding: 0 0 80px 0; }

        .oct-table {
          width: 100%; background: #fff; border-radius: 0;
          overflow: hidden; border: none;
          box-shadow: none;
          font-family: 'Inter', sans-serif;
        }
        :global(body.dark) .oct-table { background: #141414; }

        .oct-head { display: grid; grid-template-columns: 1fr 1fr 1fr; font-size: 0.925rem; font-weight: 800; letter-spacing: 0.5px; }
        .oct-head-calls  { background: #edf7f0; color: #000; text-align: center; padding: 14px 0 18px; }
        .oct-head-strike { background: #fefbe8; color: #000; text-align: center; padding: 14px 0 18px; }
        .oct-head-puts   { background: #fff0eb; color: #000; text-align: center; padding: 14px 0 18px; }
        :global(body.dark) .oct-head-calls  { background: #1a2e1c; color: #fff; }
        :global(body.dark) .oct-head-puts   { background: #2e1a1a; color: #fff; }
        :global(body.dark) .oct-head-strike { background: #252010; color: #fff; }

        .oct-subhead {
          display: grid; grid-template-columns: 1fr 1fr 1fr;
          font-size: 0.845rem; font-weight: 700;
          position: sticky; top: ${stickyTop}px; z-index: 20;
          border-bottom: 1px solid #e8eaf0;
          transition: box-shadow 0.15s;
        }
        .oct-subhead.floating { box-shadow: 0 4px 16px rgba(0,0,0,0.1); overflow: hidden; }
        :global(body.dark) .oct-subhead { border-bottom-color: #252525; }
        :global(body.dark) .oct-subhead.floating { box-shadow: 0 4px 16px rgba(0,0,0,0.5); }

        .oct-sub-calls, .oct-sub-puts {
          background: #fff; color: #000;
          display: flex; justify-content: space-around; align-items: center; padding: 10px 8px;
        }
        .oct-sub-strike {
          background: #fff; color: #000; text-align: center;
          display: flex; align-items: center; justify-content: center;
          padding: 10px 0; font-size: 0.975rem;
        }
        :global(body.dark) .oct-sub-calls  { background: #141414; color: #a3a3a3; }
        :global(body.dark) .oct-sub-puts   { background: #141414; color: #a3a3a3; }
        :global(body.dark) .oct-sub-strike { background: #141414; color: #a3a3a3; }

        .oct-body {
          display: flex; flex-direction: column;
          height: 462px; overflow-y: auto;
          scrollbar-width: none; -ms-overflow-style: none;
          padding-top: 8px;
        }
        .oct-body::-webkit-scrollbar { display: none; }
      `}</style>
    </div>
  );
}
