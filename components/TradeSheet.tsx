'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useOrderEntry, OrderType, ProductType } from '@/hooks/useOrderEntry';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import AnimatedLoader from '@/components/AnimatedLoader';

import { supabase } from '@/lib/supabaseClient';
import { api, ApiError } from '@/lib/api';
import { useActivePositions } from '@/hooks/useActivePositions';
import { cleanSym } from '@/contexts/PositionsContext';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';
import { calculateMarginPortion } from '@/lib/trading/MarginCalculator';
import { calculateOrderBrokerage } from '@/lib/trading/BrokerageCalculator';
import { ErrorModal } from '@/components/ErrorModal';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import { useBalance } from '@/hooks/useBalance';
import { mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { resolveEffectivePrices } from '@/lib/trading/marketPriceResolver';
import { generateRealisticFallbackQuote, FallbackQuote } from '@/lib/quoteFallback';
import type { TradingInstrument } from '@/lib/types/instrument';
import { useMyOrders } from '@/hooks/useMyOrders';
import { fmtSymbolName } from '@/lib/format';
import TickFlash from '@/components/TickFlash';
import { RiskValidation } from '@/lib/trading/RiskValidation';

/**
 * @deprecated Import `TradingInstrument` from `@/lib/types/instrument` instead.
 * Kept as a type alias during migration so existing `as TradeSheetItem` casts
 * still compile without changes at every call site.
 */
export type TradeSheetItem = TradingInstrument;

interface TradeSheetProps {
  item: TradingInstrument | null;
  side: 'BUY' | 'SELL' | 'BOTH';
  onClose: () => void;
  onSuccess?: () => void;
  /** When true: hides GTT order type and hides Product Type section entirely */
  exitMode?: boolean;
  productType?: ProductType;
  initialOrder?: any;
  isModify?: boolean;
  modifyingOrderId?: string | null;
  isFromPositions?: boolean;
  linkedPosId?: string | null;
  initialExitQty?: number;
  hideLotText?: boolean;
}

export default function TradeSheet({ item, side, onClose, onSuccess, exitMode = false, productType: propProductType, initialOrder, isModify = false, modifyingOrderId, isFromPositions = false, linkedPosId = null, initialExitQty: propInitialExitQty, hideLotText = false }: TradeSheetProps) {
  const effectiveExitMode = Boolean(
    exitMode ||
    initialOrder?.is_exit ||
    initialOrder?.isExit ||
    Boolean(modifyingOrderId && (modifyingOrderId.startsWith('pos-sl-') || modifyingOrderId.startsWith('pos-target-') || modifyingOrderId.startsWith('pos-gtt-')))
  );

  const { placeOrder, loading: placingOrder } = useOrderEntry();

  const isClosing = false;
  const handleCloseAnimation = () => {
    onClose();
  };

  const [orderUnit, setOrderUnit] = useState<'qty' | 'lot'>('qty');
  const [orderQty, setOrderQty] = useState(1);
  const [qtyInput, setQtyInput] = useState('1'); // string for free typing
  const [orderType, setOrderType] = useState<string>('MARKET');
  const [productType, setProductType] = useState<ProductType>('INTRADAY');
  const [limitPrice, setLimitPrice] = useState('');
  const [triggerPrice, setTriggerPrice] = useState('');
  const [slPrice, setSlPrice] = useState('');
  const [tpPrice, setTpPrice] = useState('');
  const [gttSubOption, setGttSubOption] = useState<string>('LIMIT');
  // Balance comes from the global BalanceDataProvider â€” no local fetch needed
  const { balance: availableBalance } = useBalance();
  const { updateOrderLocally } = useMyOrders();
  const [toast, setToast] = useState<string | null>(null);
  const [qtyError, setQtyError] = useState<string | null>(null);

  // â”€â”€ Explicit order lifecycle state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Replaces independent isSubmitting + orderError booleans/strings that could
  // simultaneously describe contradictory states (e.g. processing=true while
  // errorMsg is set). Only one state is active at a time.
  type OrderState = 'idle' | 'processing' | 'error';
  const [orderState, setOrderState] = useState<OrderState>('idle');
  const [orderErrorMsg, setOrderErrorMsg] = useState<string | null>(null);

  // Derived convenience aliases kept for JSX readability
  const isSubmitting = orderState === 'processing';
  const orderError = orderState === 'error' ? orderErrorMsg : null;
  // isBusy gates the BUY/SELL footer buttons â€” also checks the hook's own loading flag
  const isBusy = placingOrder || isSubmitting;
  const isExpired = useMemo(() => {
    if (!item?.expiry || effectiveExitMode || isModify) return false;
    const expiryDate = new Date(item.expiry);
    const now = new Date();
    expiryDate.setUTCHours(0, 0, 0, 0);
    now.setUTCHours(0, 0, 0, 0);
    return expiryDate < now;
  }, [item?.expiry, effectiveExitMode, isModify]);

  const isSpotIndex = useMemo(() => {
    if (!item) return false;
    const spotKiteSymbols = [
      'NSE:NIFTY 50', 'NSE:NIFTY BANK', 'BSE:SENSEX', 'BSE:BANKEX',
      'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY MID SELECT', 'NSE:INDIA VIX'
    ];
    if (item.kiteSymbol && spotKiteSymbols.includes(item.kiteSymbol.toUpperCase())) return true;

    const nameUpper = (item.name || '').toUpperCase();
    if (nameUpper.includes('INDEX') && !nameUpper.includes('FUT') && !nameUpper.includes('CE') && !nameUpper.includes('PE')) return true;

    return false;
  }, [item]);

  // getLotSize and getSegment come from the shared TradeConfigProvider
  const { getLotSize, getSegment } = useTradeConfig();
  const [showCharges, setShowCharges] = useState(false);

  const { positions: activePositions, refreshPositions } = useActivePositions();

  const isOpen = !!item;
  const rawLotSize = Number((item as any)?.lot_size ?? (item as any)?.lotSize ?? 0);
  const lotSize = (item && rawLotSize > 0)
    ? rawLotSize
    : (item ? getLotSize(item.symbol || item.name || '') : 1);

  const dbSeg = item ? mapSegmentWithSymbol(item.segment, item.symbol) : '';
  const isCrypto = !!item?.binanceSymbol ||
    (item?.segment || '').toUpperCase() === 'CRYPTO' ||
    (item?.segment || '').toUpperCase() === 'CRYPTO-FUT' ||
    ['BTC', 'ETH', 'DOGE', 'SOL', 'XRP', 'ADA', 'BNB', 'DOT', 'LTC', 'AVAX', 'MATIC'].includes(item?.symbol || '');
  const isComex = item && (item as any).preferredView
    ? (item as any).preferredView === 'comex'
    : (dbSeg.toUpperCase().includes('COMEX') || !!item?.comexSymbol || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => (item?.symbol || '').toUpperCase().includes(c)));

  const symCheck = ((item?.symbol || '') + ' ' + (item?.name || '') + ' ' + (item?.kiteSymbol || '')).toUpperCase();
  const isForexUsd = symCheck.includes('GBPUSD') || symCheck.includes('EURUSD') || symCheck.includes('GBP/USD') || symCheck.includes('EUR/USD');
  const isUsdItem = false;
  const currencySymbol = '₹';
  const priceLocale = 'en-IN';

  let bSymbol = item?.binanceSymbol || (item && isCrypto && item.symbol ? item.symbol.replace('/', '') : '');
  if (bSymbol && !bSymbol.endsWith('USDT')) {
    bSymbol = bSymbol + 'USDT';
  }
  const computedKiteSymbol = useMemo(() => {
    let k = item?.kiteSymbol || item?.symbol;
    if (k) {
      if (isComex || dbSeg === 'COMEX' || ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => (item?.symbol || '').toUpperCase().includes(c))) {
        return k.startsWith('COMEX:') ? k : `COMEX:${k.replace(/^COMEX:/i, '')}`;
      }
      if (isCrypto || dbSeg === 'CRYPTO') {
        return k.startsWith('CRYPTO:') ? k : `CRYPTO:${k.replace(/^CRYPTO:/i, '')}`;
      }
      if ((item?.segment || '').toUpperCase().includes('US-EQ') || (item?.symbol || '').toUpperCase().startsWith('US:')) {
        return k.startsWith('US:') ? k : `US:${k.replace(/^US:/i, '')}`;
      }
      if (!k.includes(':')) {
        const cleanSym = k.toUpperCase();
        const isOption = (cleanSym.endsWith('CE') || cleanSym.endsWith('PE')) && /\d/.test(cleanSym);
        const isFut = cleanSym.endsWith('FUT') || cleanSym.includes('FUTURES');
        let prefix = 'NSE';
        if (cleanSym.includes('SENSEX') || cleanSym.includes('BANKEX')) {
          prefix = 'BFO';
        } else if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'NATGAS', 'MCX', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(x => cleanSym.includes(x))) {
          prefix = 'MCX';
        } else if (isOption || isFut) {
          prefix = 'NFO';
        }
        k = `${prefix}:${cleanSym}`;
      }
    }
    return k;
  }, [item?.kiteSymbol, item?.symbol, isComex, isCrypto, dbSeg]);

  const marketSymbols = useMemo(() => {
    const list: string[] = [];
    if (computedKiteSymbol) list.push(computedKiteSymbol);
    if (item?.kiteSymbol && !list.includes(item.kiteSymbol)) list.push(item.kiteSymbol);
    if (item?.symbol && !list.includes(item.symbol)) list.push(item.symbol);
    if (item?.name && !list.includes(item.name)) list.push(item.name);
    if (item?.symbol && !list.includes(item.symbol.replace(/\s+/g, ''))) list.push(item.symbol.replace(/\s+/g, ''));
    if (isCrypto && item?.symbol) {
      const cleanCrypto = item.symbol.replace('/', '');
      if (!list.includes(cleanCrypto)) list.push(cleanCrypto);
    }
    if (bSymbol && !list.includes(bSymbol)) {
      list.push(bSymbol);
    }
    return list;
  }, [computedKiteSymbol, item?.kiteSymbol, item?.symbol, item?.name, isCrypto, bSymbol]);

  const comexSymbolKey = item?.comexSymbol || (item?.symbol?.endsWith('=F') ? item.symbol : (
    (item?.name || item?.symbol || '').toUpperCase().includes('SILVER') ? 'XAGUSD' :
    (item?.name || item?.symbol || '').toUpperCase().includes('GOLD') ? 'XAUUSD' :
    (item?.name || item?.symbol || '').toUpperCase().includes('CRUDE') ? 'XTIUSD' :
    (item?.name || item?.symbol || '').toUpperCase().includes('COPPER') ? 'XCUUSD' :
    (item?.name || item?.symbol || '').toUpperCase().includes('NAT') ? 'XNGUSD' : ''
  ));

  const comexSymbols = useMemo(() => {
    if (comexSymbolKey) return [comexSymbolKey];
    return [];
  }, [comexSymbolKey]);

  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexSymbols);

  let currentLtp = typeof item?.price === 'string'
    ? parseFloat((item.price as string).replace(/,/g, ''))
    : (item?.price ?? 0);
  let currentChangePercent = parseFloat(item?.change?.replace(/[%+]/g, '') || '0') || 0;

  const cryptoQuote = isCrypto && bSymbol ? (marketQuotes[bSymbol] || marketQuotes[item?.symbol?.replace('/', '') || '']) : null;
  const cleanSymUpper = item?.symbol ? item.symbol.replace(/^US:/i, '').trim().toUpperCase() : '';
  const activeKiteQuote = (computedKiteSymbol && marketQuotes[computedKiteSymbol]) ||
    (item?.kiteSymbol && marketQuotes[item.kiteSymbol]) ||
    (item?.symbol && marketQuotes[item.symbol]) ||
    (cleanSymUpper && marketQuotes[cleanSymUpper]) ||
    (cleanSymUpper && marketQuotes[`US:${cleanSymUpper}`]) ||
    (item?.symbol && marketQuotes[item.symbol.replace(/\s+/g, '')]) ||
    (item?.name && marketQuotes[item.name]) ||
    null;

  if (isCrypto && bSymbol && cryptoQuote) {
    currentLtp = cryptoQuote.lastPrice || currentLtp;
    const prevClose = (cryptoQuote as any).prevClosePrice ?? (cryptoQuote as any).close ?? currentLtp;
    currentChangePercent = (cryptoQuote as any).changePercent ?? (prevClose > 0 ? ((currentLtp - prevClose) / prevClose) * 100 : 0);
  } else if (isComex && (comexSymbolKey || item?.symbol || item?.comexSymbol)) {
    const q = (comexSymbolKey && comexQuotes[comexSymbolKey]) ||
              (item?.comexSymbol && comexQuotes[item.comexSymbol]) ||
              (comexSymbolKey && marketQuotes[comexSymbolKey]) ||
              (item?.symbol && marketQuotes[item.symbol]) ||
              activeKiteQuote;
    if (q) {
      currentLtp = q.lastPrice || (q as any).price || currentLtp;
      currentChangePercent = q.changePercent || 0;
    }
  } else if (activeKiteQuote) {
    currentLtp = activeKiteQuote.lastPrice;
    currentChangePercent = activeKiteQuote.changePercent;
  }

  if (isForexUsd && currentLtp > 0 && currentLtp < 20) {
    currentLtp *= usdInrRate;
  }

  // Fallback: if still no price and comexSymbol exists, use COMEX USD price
  if (currentLtp === 0 && item?.comexSymbol && comexQuotes[item.comexSymbol]) {
    currentLtp = comexQuotes[item.comexSymbol].lastPrice;
    currentChangePercent = comexQuotes[item.comexSymbol].changePercent;
  }

  if (currentLtp === 0 && initialOrder) {
    const rawPrice = initialOrder.client_price || initialOrder.trigger_price || initialOrder.target || initialOrder.stop_loss;
    if (rawPrice) {
      currentLtp = typeof rawPrice === 'string' ? parseFloat(rawPrice) || 0 : rawPrice;
    }
  }

  let fallbackQuoteObj: FallbackQuote | null = null;
  if (currentLtp === 0 && item) {
    const fallbackKey = item.symbol || item.kiteSymbol || item.name || '';
    fallbackQuoteObj = generateRealisticFallbackQuote(fallbackKey);
    currentLtp = fallbackQuoteObj.last_price;
    currentChangePercent = fallbackQuoteObj.changePercent;
  }

  const activeSide: 'BUY' | 'SELL' = (side === 'SELL' || side === 'BUY') ? side : 'BUY';
  const buySetting = dbSeg ? getSegment(dbSeg, 'BUY') : undefined;
  const sellSetting = dbSeg ? getSegment(dbSeg, 'SELL') : undefined;
  const segSetting = side === 'SELL' ? sellSetting : buySetting;

  const buyEntryBuffer = buySetting ? buySetting.entry_buffer : 0;
  const buyExitBuffer = buySetting ? buySetting.exit_buffer : 0;
  const sellEntryBuffer = sellSetting ? sellSetting.entry_buffer : 0;
  const sellExitBuffer = sellSetting ? sellSetting.exit_buffer : 0;

  let bidPrice = 0;
  let askPrice = 0;
  let rawBid = 0;
  let rawAsk = 0;

  if (currentLtp > 0) {
    const activeCryptoQuote = bSymbol ? marketQuotes[bSymbol] : null;
    if (isCrypto && activeCryptoQuote) {
      rawBid = (activeCryptoQuote?.bid && activeCryptoQuote.bid > 0) ? activeCryptoQuote.bid : currentLtp;
      rawAsk = (activeCryptoQuote?.ask && activeCryptoQuote.ask > 0) ? activeCryptoQuote.ask : currentLtp;
    } else if (isComex && item?.comexSymbol && comexQuotes[item.comexSymbol]) {
      rawBid = comexQuotes[item.comexSymbol].bid || currentLtp;
      rawAsk = comexQuotes[item.comexSymbol].ask || currentLtp;
    } else if (activeKiteQuote) {
      rawBid = activeKiteQuote.bid || currentLtp;
      rawAsk = activeKiteQuote.ask || currentLtp;
    } else if (fallbackQuoteObj) {
      rawBid = fallbackQuoteObj.bid || currentLtp;
      rawAsk = fallbackQuoteObj.ask || currentLtp;
    }

    if (!rawBid || rawBid <= 0) rawBid = currentLtp;
    if (!rawAsk || rawAsk <= 0) rawAsk = currentLtp;

    if (isForexUsd) {
      if (rawBid > 0 && rawBid < 20) rawBid *= usdInrRate;
      if (rawAsk > 0 && rawAsk < 20) rawAsk *= usdInrRate;
    }

    const isCommodity = dbSeg.toUpperCase().includes('MCX') ||
      ['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(c => (item?.symbol || item?.name || item?.kiteSymbol || '').toUpperCase().includes(c));
    const isIndianNonCommodity = (!isCrypto && !isComex) && !isCommodity;

    // ── Two-Layer Price Model: Layer 1 (Display) ──────────────────────────────
    // bid_buffer is used ONLY for display. entry/exit buffers are applied at
    // execution time (hidden from user) on top of these displayed prices.
    //
    // LTP mode    : Ask = LTP + LTP*bid_buffer%   |  Bid = LTP - LTP*bid_buffer%
    // BID/ASK mode: Ask = RealAsk + LTP*bid_buffer%  |  Bid = RealBid - LTP*bid_buffer%
    const bidBufferRaw = segSetting?.bid_buffer ?? 0;
    const bidBufferDecimal = Math.abs(bidBufferRaw) > 0.005 ? bidBufferRaw / 100 : bidBufferRaw;
    const bidBufferAmount = currentLtp * bidBufferDecimal; // always LTP-based

    const execPriceMode = segSetting?.exit_price_mode || 'BID_ASK';
    const hasRealBidAsk = Boolean(rawBid && rawAsk && rawBid > 0 && rawAsk > 0 && rawBid < rawAsk);
    const useLtpMode = execPriceMode === 'LTP' || !hasRealBidAsk;

    if (useLtpMode) {
      askPrice = currentLtp + bidBufferAmount;
      bidPrice = currentLtp - bidBufferAmount;
    } else {
      askPrice = rawAsk + bidBufferAmount;
      bidPrice = rawBid - bidBufferAmount;
    }

    // Sanity: ensure bid > 0 and ask >= bid
    if (bidPrice <= 0) bidPrice = currentLtp;
    if (askPrice <= 0) askPrice = currentLtp;
  }

  const priceOfScript = activeSide === 'SELL' ? rawBid : rawAsk;

  const intradayLeverage = segSetting?.intraday_leverage ?? 10;
  const holdingLeverage = segSetting?.holding_leverage ?? 10;
  const leverage = productType === 'CARRY' ? holdingLeverage : intradayLeverage;

  const totalQty = orderUnit === 'lot' ? orderQty * lotSize : orderQty;
  const effectivePrice = side === 'SELL' ? bidPrice : askPrice;
  // Compute individual charge amounts for display
  const chargePrice = (orderType === 'LIMIT' || orderType === 'TARGET' || orderType === 'GTT') && limitPrice && !isNaN(parseFloat(limitPrice))
    ? parseFloat(limitPrice) : (currentLtp > 0 ? currentLtp : 0);
  const chargeQty = orderUnit === 'lot' ? orderQty * lotSize : orderQty;
  const chargeExposure = chargeQty * chargePrice;

  const targetItemSymClean = cleanSym(item?.symbol || '');
  const isMatchingSymbol = (pSym?: string) => {
    if (!pSym || !targetItemSymClean) return false;
    const pClean = cleanSym(pSym);
    return pClean === targetItemSymClean;
  };

  const anyPosForSymbol = activePositions.find(p => isMatchingSymbol(p.symbol) && ((p.status as string) === 'open' || (p.status as string) === 'OPEN' || (p.status as string) === 'active'));
  const effectiveProductType = propProductType || (linkedPosId ? activePositions.find(p => p.id === linkedPosId)?.product_type : undefined) || (effectiveExitMode && anyPosForSymbol ? anyPosForSymbol.product_type : undefined) || productType;
  const targetPT = effectiveProductType as 'INTRADAY' | 'CARRY';
  const existingPos = activePositions.find(p => isMatchingSymbol(p.symbol) && ((p.status as string) === 'open' || (p.status as string) === 'OPEN' || (p.status as string) === 'active') && p.product_type === targetPT) || anyPosForSymbol;
  // Total qty across all open lots for this symbol+product_type (for multi-lot exit validation)
  const totalOpenQtyForSymbol = activePositions
    .filter(p => isMatchingSymbol(p.symbol) && ((p.status as string) === 'open' || (p.status as string) === 'OPEN' || (p.status as string) === 'active') && p.product_type === targetPT && p.side === existingPos?.side)
    .reduce((sum, p) => sum + (Number(p.qty_open) || 0), 0);
  const hasSellPos = existingPos?.side === 'SELL' || false;
  const hasBuyPos = existingPos?.side === 'BUY' || false;

  const isExitTrade = effectiveExitMode || (!isModify && ((activeSide === 'BUY' && hasSellPos) || (activeSide === 'SELL' && hasBuyPos)));

  // Fallback defaults if segSetting is completely missing
  const fallbackCommType = 'Per Crore';
  let fallbackCommVal = 4500;
  const sUpper2 = (item?.segment || '').toUpperCase();
  if (sUpper2.includes('FOREX')) {
    fallbackCommVal = 2000;
  } else if (sUpper2.includes('CRYPTO')) {
    fallbackCommVal = 1000;
  }

  const chargeLots = orderUnit === 'lot' ? orderQty : (totalQty / (lotSize > 0 ? lotSize : 1));

  const brokerageResult = calculateOrderBrokerage({
    exposure: chargeExposure,
    lots: chargeLots,
    productType: targetPT,
    orderType: orderType,
    isExit: isExitTrade,
    segSetting: segSetting,
    dbSegment: dbSeg,
    fallbackCommType,
    fallbackCommVal,
  });

  const calculatedBrokerage = brokerageResult.totalBrokerage;

  // For charges breakdown UI when in exit mode: compute leg breakdown with isExit: false
  const displayBrokerageResult = isExitTrade ? calculateOrderBrokerage({
    exposure: chargeExposure,
    lots: chargeLots,
    productType: targetPT,
    orderType: orderType,
    isExit: false,
    segSetting: segSetting,
    dbSegment: dbSeg,
    fallbackCommType,
    fallbackCommVal,
  }) : brokerageResult;

  const displayBrokerage = displayBrokerageResult.displayBrokerage;
  const displayIntraday = displayBrokerageResult.entryIntradayCharge;
  const displayCarry = displayBrokerageResult.entryCarryCharge;
  const displayGtt = displayBrokerageResult.entryGttCharge;

  const intradayType = segSetting?.intraday_type ?? 'Multiplier';
  const holdingType = segSetting?.holding_type ?? 'Multiplier';
  const leverageType = productType === 'CARRY' ? holdingType : intradayType;

  const baseExposure = (orderType === 'LIMIT' || orderType === 'TARGET' || orderType === 'GTT') && limitPrice && !isNaN(parseFloat(limitPrice))
    ? (totalQty * parseFloat(limitPrice))
    : (totalQty * (priceOfScript > 0 ? priceOfScript : 0));

  let marginPortion = 0;
  if (!effectiveExitMode) {
    marginPortion = calculateMarginPortion({
      segment: dbSeg,
      side: activeSide,
      leverageType,
      leverage,
      totalQty,
      lotSize,
      baseExposure
    });
  }
  const entryBufferCost = baseExposure * (side === 'SELL' ? sellEntryBuffer : buyEntryBuffer);
  const exitBufferCost = baseExposure * (side === 'SELL' ? sellExitBuffer : buyExitBuffer);

  const requiredMargin = isExitTrade ? 0 : Math.round(marginPortion + calculatedBrokerage);

  const userHasEditedQty = useRef(false);
  const activePositionsRef = useRef(activePositions);
  useEffect(() => { activePositionsRef.current = activePositions; }, [activePositions]);

  // Sync qtyInput → orderQty when input is a valid number (supports decimals in lot mode)
  const handleQtyChange = (val: string) => {
    // Allow digits, a leading optional zero, and a single decimal point
    if (val !== '' && !/^\d*\.?\d*$/.test(val)) return;

    userHasEditedQty.current = true;
    setQtyInput(val);
    if (qtyError) setQtyError(null);
    const n = parseFloat(val);
    // Only update the committed qty when we have a real positive number
    if (!isNaN(n) && n > 0) setOrderQty(n);
  };

  const stepQty = (delta: number) => {
    if (qtyError) setQtyError(null);
    const step = orderUnit === 'lot' ? 1 : (lotSize > 1 ? lotSize : 1);
    const maxOrderLot = segSetting?.max_order_lot ?? segSetting?.max_lot ?? 0;
    const maxVal = maxOrderLot > 0
      ? (orderUnit === 'lot' ? maxOrderLot : maxOrderLot * lotSize)
      : Infinity;
    const minVal = orderUnit === 'lot' ? 0.0001 : 1;
    const next = Math.min(maxVal, Math.max(minVal, parseFloat((orderQty + delta * step).toFixed(4))));
    setOrderQty(next);
    setQtyInput(String(next));
  };

  // Reset state when item changes
  useEffect(() => {
    if (item) {
      if (initialOrder) {
        setOrderQty(initialOrder.qty);
        setQtyInput(String(initialOrder.qty));
        setOrderUnit('qty');
        const isExitFlow = effectiveExitMode;
        const initialOrderType = (isExitFlow && (initialOrder.order_type === 'LIMIT' || initialOrder.order_type === 'TARGET')) ? 'TARGET' : (isExitFlow && initialOrder.order_type === 'SLM' ? 'SL' : initialOrder.order_type);
        setOrderType(initialOrderType);
        setProductType(initialOrder.product_type);
        setLimitPrice(initialOrder.client_price ? String(initialOrder.client_price) : (initialOrder.target ? String(initialOrder.target) : ''));
        setTriggerPrice(initialOrder.trigger_price ? String(initialOrder.trigger_price) : (initialOrder.stop_loss ? String(initialOrder.stop_loss) : ''));
        setSlPrice(initialOrder.stop_loss ? String(initialOrder.stop_loss) : '');
        setTpPrice(initialOrder.target ? String(initialOrder.target) : '');
        if (initialOrder.order_type === 'GTT') {
          if (initialOrder.target) {
            setGttSubOption('TARGET');
          } else if (initialOrder.stop_loss) {
            setGttSubOption('SL');
          } else {
            setGttSubOption('LIMIT');
          }
        } else {
          setGttSubOption(isExitFlow ? 'TARGET' : 'LIMIT');
        }
      } else {
        const defaultQty = lotSize > 0 ? lotSize : 1;
        setOrderQty(defaultQty);
        setQtyInput(String(defaultQty));
        setOrderUnit('qty');
        setOrderType('MARKET');
        setProductType(propProductType || 'INTRADAY');
        setLimitPrice('');
        setTriggerPrice('');
        setSlPrice('');
        setTpPrice('');
        setGttSubOption(effectiveExitMode ? 'TARGET' : 'LIMIT');
        userHasEditedQty.current = false;
      }
    }
  }, [item?.symbol, propProductType, exitMode, isModify, initialOrder, modifyingOrderId, linkedPosId, effectiveExitMode]);

  // Sync maximum position quantity when opening against an existing position
  useEffect(() => {
    if (isOpen && item && !initialOrder) {
      const targetPT = propProductType || productType;
      const oppositeSide = side === 'SELL' ? 'BUY' : 'SELL';

      let initialExitQty = propInitialExitQty || 0;
      if (!initialExitQty) {
        if (linkedPosId) {
          const exactPos = activePositionsRef.current?.find(p => p.id === linkedPosId);
          if (exactPos) initialExitQty = exactPos.qty_open;
        } else {
          const matchingPositions = activePositionsRef.current?.filter(
            p => isMatchingSymbol(p.symbol) && ((p.status as string) === 'open' || (p.status as string) === 'active') && p.side === oppositeSide && p.product_type === targetPT
          ) || [];
          initialExitQty = matchingPositions.reduce((sum, p) => sum + p.qty_open, 0);
        }
      }

      if (initialExitQty > 0 && !userHasEditedQty.current) {
        setOrderUnit('qty');
        setOrderQty(initialExitQty);
        setQtyInput(String(initialExitQty));
      }
    }
    // Intentionally exclude activePositions â€” only run when sheet opens or side changes,
    // never on background polls (which would stomp user-edited qty)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side, isOpen, item?.symbol, propProductType, exitMode, linkedPosId, effectiveExitMode]);

  // Fetch balance and refresh active positions when the sheet opens
  useEffect(() => {
    if (!isOpen) return;
    refreshPositions();
  }, [isOpen, refreshPositions]);

  const showToast = (msg: string) => {
    setToast(msg);
    setOrderErrorMsg(null);
    window.dispatchEvent(new CustomEvent('toast_msg', { detail: msg }));
    setTimeout(() => setToast(null), 1800);
  };

  const showOrderError = (msg: string) => {
    setToast(msg);
    setOrderErrorMsg(msg);
    window.dispatchEvent(new CustomEvent('order_error', { detail: msg }));
    setTimeout(() => setToast(null), 2500);
  };



  const realExitOrder = Boolean(exitMode || initialOrder?.is_exit || initialOrder?.isExit || (modifyingOrderId && (modifyingOrderId.startsWith('pos-sl-') || modifyingOrderId.startsWith('pos-target-') || modifyingOrderId.startsWith('pos-gtt-'))));

  const isLongPosition = realExitOrder ? activeSide === 'SELL' : activeSide === 'BUY';

  const topLimit = segSetting?.top_limit ?? 0;
  const minLimit = segSetting?.min_limit ?? 0;

  let maxAllowedPrice = topLimit > 0 ? currentLtp * (1 + topLimit / 100) : Infinity;
  let minAllowedPrice = minLimit > 0 ? currentLtp * (1 - minLimit / 100) : 0;

  if (orderType === 'LIMIT') {
    if (activeSide === 'BUY') {
      maxAllowedPrice = Math.min(maxAllowedPrice, currentLtp);
    } else if (activeSide === 'SELL') {
      minAllowedPrice = Math.max(minAllowedPrice, currentLtp);
    }
  } else if (orderType === 'TARGET') {
    if (isLongPosition) {
      minAllowedPrice = Math.max(minAllowedPrice, currentLtp);
    } else {
      maxAllowedPrice = Math.min(maxAllowedPrice, currentLtp);
    }
  } else if (orderType === 'SL' || orderType === 'SLM') {
    if (isLongPosition) {
      maxAllowedPrice = Math.min(maxAllowedPrice, currentLtp);
    } else {
      minAllowedPrice = Math.max(minAllowedPrice, currentLtp);
    }
  }

  const formattedLtp = `${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  let priceRangeText = '';
  if (orderType === 'TARGET') {
    priceRangeText = isLongPosition
      ? `more than ${formattedLtp}`
      : `less than ${formattedLtp}`;
  } else if (orderType === 'LIMIT') {
    priceRangeText = activeSide === 'BUY'
      ? `less than ${formattedLtp}`
      : `more than ${formattedLtp}`;
  } else if (orderType === 'SL' || orderType === 'SLM') {
    priceRangeText = isLongPosition
      ? `less than ${formattedLtp}`
      : `more than ${formattedLtp}`;
  } else {
    priceRangeText = `Market price`;
  }

  const priceRangeHelp = currentLtp > 0 ? (
    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary, #6B7280)', marginTop: '6px', fontWeight: 600 }}>
      {priceRangeText}
    </div>
  ) : null;

  const isExecutingRef = useRef(false);

  const handlePlace = async (placeSide: 'BUY' | 'SELL') => {
    // Synchronous guard â€” isExecutingRef is checked before any await so no
    // concurrent call can slip through during a React render cycle.
    // Also reject if the UI is already showing an error (user must dismiss first).
    if (isExecutingRef.current || orderState !== 'idle') return;
    isExecutingRef.current = true;
    setOrderState('processing');
    let handedOffToOrderFlow = false;
    let currentExitMode = effectiveExitMode;
    let currentLinkedPosId = linkedPosId;
    try {
      if (!item) return;

      const isExit = Boolean(currentExitMode || (placeSide === 'BUY' && hasSellPos) || (placeSide === 'SELL' && hasBuyPos));
      if (!isExit) {
        const segId = RiskValidation.resolveTradingHoursSegmentId(item.symbol, item.segment || '');
        if (!RiskValidation.isMarketOpenForSegment(segId)) {
          showOrderError('Market is closed');
          return;
        }
      }

      const parsedInputQty = parseFloat(qtyInput);
      if (isNaN(parsedInputQty) || parsedInputQty <= 0) {
        showOrderError('Please enter a valid quantity.');
        return;
      }

      let rawQty = orderUnit === 'lot' ? parsedInputQty * lotSize : parsedInputQty;

      // â”€â”€ Quantity Snapping & Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (effectiveExitMode) {
        let maxExitQty = 0;
        if (linkedPosId) {
          // Specific-position exit: cap to that position's qty_open only
          const exactPos = activePositionsRef.current?.find(p => p.id === linkedPosId);
          maxExitQty = exactPos?.qty_open ?? 0;
        } else if (existingPos) {
          // General exit: cap to TOTAL qty across all open lots for this symbol
          maxExitQty = totalOpenQtyForSymbol || existingPos.qty_open;
        }
        if (maxExitQty > 0 && rawQty > maxExitQty) {
          showOrderError(`Error: Exit qty (${rawQty}) exceeds this lot's available qty (${maxExitQty}). Please reduce the quantity.`);
          setQtyError(`Cannot exceed ${maxExitQty} qty for this lot`);
          return;
        }
      } else {
        const placeSetting = dbSeg ? getSegment(dbSeg, placeSide) : undefined;
        const maxOrderLot = placeSetting?.max_order_lot ?? placeSetting?.max_lot ?? 0;
        if (maxOrderLot > 0) {
          const maxOrderQty = maxOrderLot * lotSize;
          if (rawQty > maxOrderQty) {
            setQtyError(`Max ${maxOrderLot} lots or ${maxOrderQty} qty per order`);
            showOrderError(`The maximum allowed per order is ${maxOrderLot} lots or ${maxOrderQty} qty. Please place your trade in multiple orders.`);
            return;
          }
        }
      }

      const finalQty = rawQty;
      const finalLots = finalQty / lotSize;

      // Load setting specific to the side being placed
      const placeSetting = dbSeg ? getSegment(dbSeg, placeSide) : undefined;
      const pTopLimit = placeSetting?.top_limit ?? 0;
      const pMinLimit = placeSetting?.min_limit ?? 0;
      // â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

      // Resolve order_type, trigger_price, stop_loss, target, client_price under the hood
      let resolvedOrderType = orderType;
      let resolvedClientPrice: number | undefined = currentLtp;
      let resolvedTriggerPrice: number | undefined = undefined;
      let resolvedStopLoss: number | undefined = undefined;
      let resolvedTarget: number | undefined = undefined;

      const isExitOrModifyFlow = currentExitMode || isModify;

      if (isExitOrModifyFlow) {
        if (orderType === 'TARGET') {
          resolvedOrderType = 'LIMIT';
          resolvedClientPrice = parseFloat(limitPrice) || currentLtp;
          resolvedTarget = resolvedClientPrice;
        } else if (orderType === 'SL') {
          resolvedOrderType = 'SL';
          resolvedTriggerPrice = parseFloat(triggerPrice) || undefined;
          resolvedClientPrice = currentLtp;
          resolvedStopLoss = resolvedTriggerPrice;
        } else if (orderType === 'SLM') {
          // SLM in exit/modify flow = market exit (trigger_price is the SL level for reference)
          resolvedOrderType = 'SLM';
          resolvedTriggerPrice = parseFloat(triggerPrice) || parseFloat(slPrice) || undefined;
          resolvedStopLoss = resolvedTriggerPrice;
          resolvedClientPrice = currentLtp;
        } else if (orderType === 'GTT') {
          // GTT in modify/exit flow: differentiate between entry-GTT and exit-GTT
          resolvedOrderType = 'GTT';
          if (currentExitMode || (initialOrder?.is_exit === true)) {
            // Exit-mode GTT: no limit price needed, only SL and target
            resolvedStopLoss = parseFloat(slPrice) || undefined;
            resolvedTarget = parseFloat(tpPrice) || undefined;
            resolvedClientPrice = currentLtp;
          } else {
            // Entry-mode GTT modify: limit price is the trigger condition
            resolvedClientPrice = limitPrice && !isNaN(parseFloat(limitPrice)) && parseFloat(limitPrice) > 0 ? parseFloat(limitPrice) : undefined;
            resolvedTriggerPrice = limitPrice && !isNaN(parseFloat(limitPrice)) && parseFloat(limitPrice) > 0 ? parseFloat(limitPrice) : undefined;
            resolvedStopLoss = parseFloat(slPrice) || undefined;
            resolvedTarget = parseFloat(tpPrice) || undefined;
          }
        } else if (orderType === 'LIMIT') {
          resolvedOrderType = 'LIMIT';
          resolvedClientPrice = parseFloat(limitPrice) || currentLtp;
        } else {
          // MARKET
          resolvedOrderType = 'MARKET';
          resolvedClientPrice = currentLtp;
        }
      } else {
        // Add More / Entry mode
        if (orderType === 'LIMIT') {
          resolvedOrderType = 'LIMIT';
          resolvedClientPrice = parseFloat(limitPrice) || currentLtp;
        } else if (orderType === 'SL') {
          resolvedOrderType = 'SL';
          resolvedTriggerPrice = parseFloat(triggerPrice) || undefined;
          resolvedClientPrice = parseFloat(limitPrice) || currentLtp;
          resolvedStopLoss = resolvedTriggerPrice;
        } else if (orderType === 'SLM') {
          // SLM entry = market execution now + linked SL exit order created by backend
          resolvedOrderType = 'SLM';
          resolvedTriggerPrice = parseFloat(triggerPrice) || parseFloat(slPrice) || undefined;
          resolvedStopLoss = resolvedTriggerPrice; // SL price forwarded so backend creates exit order
          resolvedClientPrice = currentLtp;
        } else if (orderType === 'GTT') {
          resolvedOrderType = 'GTT';
          resolvedClientPrice = limitPrice && !isNaN(parseFloat(limitPrice)) && parseFloat(limitPrice) > 0 ? parseFloat(limitPrice) : undefined;
          resolvedTriggerPrice = limitPrice && !isNaN(parseFloat(limitPrice)) && parseFloat(limitPrice) > 0 ? parseFloat(limitPrice) : undefined;
          resolvedStopLoss = parseFloat(slPrice) || undefined;
          resolvedTarget = parseFloat(tpPrice) || undefined;
        } else {
          // MARKET
          resolvedOrderType = 'MARKET';
          resolvedClientPrice = currentLtp;
        }
      }

      // Validate Limit price constraints relative to LTP
      const hasExplicitLimit = Boolean(limitPrice && parseFloat(limitPrice) > 0);
      if (resolvedOrderType === 'LIMIT') {
        const limitVal = parseFloat(limitPrice);
        if (!limitPrice || isNaN(limitVal) || limitVal <= 0) {
          showOrderError('Please enter a valid limit price.');
          return;
        }
        if (placeSide === 'BUY' && limitVal >= currentLtp) {
          showOrderError('Buy at limit price must be below the current market price.');
          return;
        }
        if (placeSide === 'SELL' && limitVal <= currentLtp) {
          showOrderError('Sell at limit price must be above the current market price.');
          return;
        }
      } else if (resolvedOrderType === 'GTT' && !currentExitMode && hasExplicitLimit) {
        const limitVal = parseFloat(limitPrice);
        if (placeSide === 'BUY' && limitVal >= currentLtp) {
          showOrderError('Buy at limit price must be below the current market price.');
          return;
        }
        if (placeSide === 'SELL' && limitVal <= currentLtp) {
          showOrderError('Sell at limit price must be above the current market price.');
          return;
        }
      }

      const isExitOrder = currentExitMode || (!isModify && ((placeSide === 'BUY' && hasSellPos) || (placeSide === 'SELL' && hasBuyPos)));

      // Pre-check strike range for fresh entry/add-more orders on options
      if (!isExitOrder && item?.symbol && (item.symbol.endsWith('CE') || item.symbol.endsWith('PE'))) {
        try {
          const token = (window as any).__accessToken || '';
          const checkRes = await fetch(
            `/api/market/strike-range-check?symbol=${encodeURIComponent(item.symbol)}`,
            { headers: token ? { Authorization: `Bearer ${token}` } : {} }
          );
          if (checkRes.ok) {
            const checkData = await checkRes.json();
            if (checkData.allowed === false) {
              const errMsg = checkData.reason || `Strike price ${checkData.strike} is outside the active option chain window (${checkData.min} to ${checkData.max}).`;
              setOrderErrorMsg(errMsg);
              setOrderState('error');
              window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
              isExecutingRef.current = false;
              return;
            }
          }
        } catch {
          // Fail open to let backend API enforce
        }
      }

      if (resolvedOrderType === 'SL' || resolvedOrderType === 'SLM') {
        const trigVal = parseFloat(triggerPrice);
        if (!triggerPrice || isNaN(trigVal) || trigVal <= 0) {
          showOrderError('Please enter a valid trigger price.');
          return;
        }

        if (pTopLimit > 0) {
          const maxAllowed = currentLtp * (1 + pTopLimit / 100);
          if (trigVal > maxAllowed) {
            showOrderError(`Maximum price allowed is ${currencySymbol}${maxAllowed.toFixed(2)}`);
            return;
          }
        }
        if (pMinLimit > 0) {
          const minAllowed = currentLtp * (1 - pMinLimit / 100);
          if (trigVal < minAllowed) {
            showOrderError(`Minimum price allowed is ${currencySymbol}${minAllowed.toFixed(2)}`);
            return;
          }
        }

        if (orderType === 'SL' || orderType === 'SLM') {
          const trigVal = resolvedTriggerPrice !== undefined ? resolvedTriggerPrice : (resolvedStopLoss !== undefined ? resolvedStopLoss : undefined);
          if (trigVal !== undefined && !isNaN(trigVal)) {
            const isExitTrade = realExitOrder;
            const isLong = existingPos ? (existingPos.side === 'BUY') : (isExitTrade ? (placeSide === 'SELL') : (placeSide === 'BUY'));

            if (isExitTrade) {
              // Exit SL: SL must be on the losing side of current price
              if (isLong && trigVal >= currentLtp) {
                showOrderError('Stop loss must be below current market price for a BUY position.');
                return;
              }
              if (!isLong && trigVal <= currentLtp) {
                showOrderError('Stop loss must be above current market price for a SELL position.');
                return;
              }
            } else {
              // Entry SLM: user is entering at market and setting a protective SL
              // BUY entry → SL must be BELOW current price (protect against downside)
              // SELL entry → SL must be ABOVE current price (protect against upside)
              if (placeSide === 'BUY' && trigVal >= currentLtp) {
                showOrderError('Stop loss price must be below the current market price for a BUY entry.');
                return;
              }
              if (placeSide === 'SELL' && trigVal <= currentLtp) {
                showOrderError('Stop loss price must be above the current market price for a SELL entry.');
                return;
              }
            }
          }
        }
      }

      // Resolve reference entry price and position side (Long vs Short)
      const isExitTrade = realExitOrder;
      const refEntry = (isExitTrade && existingPos) ? Number(existingPos.avg_price) : resolvedClientPrice;
      const isLong = existingPos ? (existingPos.side === 'BUY') : (isExitTrade ? (placeSide === 'SELL') : (placeSide === 'BUY'));

      if (isExitTrade) {
        if (isLong) {
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget) && resolvedTarget <= currentLtp) {
            showOrderError('Target price must be above the current market price.');
            return;
          }
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss) && resolvedStopLoss >= currentLtp) {
            showOrderError('Stop loss price must be below the current market price.');
            return;
          }
        } else {
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget) && resolvedTarget >= currentLtp) {
            showOrderError('Target price must be below the current market price.');
            return;
          }
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss) && resolvedStopLoss <= currentLtp) {
            showOrderError('Stop loss price must be above the current market price.');
            return;
          }
        }
      } else {
        // First time purchasing validations
        const hasLimitPrice = ['LIMIT', 'SL', 'GTT'].includes(resolvedOrderType) && resolvedClientPrice !== undefined && !isNaN(resolvedClientPrice);
        if (isLong) {
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss)) {
            const referencePrice = (hasLimitPrice && resolvedClientPrice !== undefined) ? resolvedClientPrice : currentLtp;
            if (resolvedStopLoss >= referencePrice) {
              showOrderError(`Stop loss price must be below the ${hasLimitPrice ? 'limit' : 'market'} price.`);
              return;
            }
          }
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget)) {
            const targetRef = hasLimitPrice ? resolvedClientPrice! : currentLtp;
            if (resolvedTarget <= targetRef) {
              showOrderError(`Target price must be above the ${hasLimitPrice ? 'limit' : 'market'} price.`);
              return;
            }
          }
        } else {
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss)) {
            const referencePrice = (hasLimitPrice && resolvedClientPrice !== undefined) ? resolvedClientPrice : currentLtp;
            if (resolvedStopLoss <= referencePrice) {
              showOrderError(`Stop loss price must be above the ${hasLimitPrice ? 'limit' : 'market'} price.`);
              return;
            }
          }
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget)) {
            const targetRef = hasLimitPrice ? resolvedClientPrice! : currentLtp;
            if (resolvedTarget >= targetRef) {
              showOrderError(`Target price must be below the ${hasLimitPrice ? 'limit' : 'market'} price.`);
              return;
            }
          }
        }
      }

      if (resolvedOrderType === 'LIMIT') {
        if (placeSide === 'BUY') {
          if (resolvedClientPrice !== undefined && resolvedClientPrice >= currentLtp) {
            showOrderError('Limit price must be lower than the current market price.');
            return;
          }
        } else {
          if (resolvedClientPrice !== undefined && resolvedClientPrice <= currentLtp) {
            showOrderError('Limit price must be higher than the current market price.');
            return;
          }
        }
      }

      if (resolvedOrderType === 'GTT' && !currentExitMode) {
        if (resolvedClientPrice === undefined || isNaN(resolvedClientPrice) || resolvedClientPrice <= 0) {
          showOrderError(placeSide === 'BUY' ? 'Limit price is required for a GTT Buy order.' : 'Limit price is required for a GTT Sell order.');
          return;
        }
        if (placeSide === 'BUY' && resolvedClientPrice > currentLtp) {
          showOrderError('Limit price must be lower than or equal to the current market price.');
          return;
        }
        if (placeSide === 'SELL' && resolvedClientPrice < currentLtp) {
          showOrderError('Limit price must be higher than or equal to the current market price.');
          return;
        }
      }

      if (['LIMIT', 'SL', 'GTT'].includes(resolvedOrderType)) {
        const parsedPrice = resolvedClientPrice ?? currentLtp;
        if (placeSide === 'BUY') {
          if (pTopLimit > 0) {
            const maxAllowed = currentLtp * (1 + pTopLimit / 100);
            if (parsedPrice > maxAllowed) {
              showOrderError(`Maximum price allowed is ${currencySymbol}${maxAllowed.toFixed(2)}`);
              return;
            }
          }
          if (pMinLimit > 0) {
            const minAllowed = currentLtp * (1 - pMinLimit / 100);
            if (parsedPrice < minAllowed) {
              showOrderError(`Minimum price allowed is ${currencySymbol}${minAllowed.toFixed(2)}`);
              return;
            }
          }
        } else { // SELL side
          if (pTopLimit > 0) {
            const maxAllowed = currentLtp * (1 + pTopLimit / 100);
            if (parsedPrice > maxAllowed) {
              showOrderError(`Maximum price allowed is ${currencySymbol}${maxAllowed.toFixed(2)}`);
              return;
            }
          }
          if (pMinLimit > 0) {
            const minAllowed = currentLtp * (1 - pMinLimit / 100);
            if (parsedPrice < minAllowed) {
              showOrderError(`Minimum price allowed is ${currencySymbol}${minAllowed.toFixed(2)}`);
              return;
            }
          }
        }
      }

      if (isModify && modifyingOrderId && (modifyingOrderId.startsWith('pos-sl-') || modifyingOrderId.startsWith('pos-target-') || modifyingOrderId.startsWith('pos-gtt-'))) {
        const positionId = modifyingOrderId.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');

        if (resolvedOrderType === 'MARKET') {
          // User changed order type to MARKET -> Clear existing SL/Target & let exit flow execute immediate market close
          try {
            await api.patch<unknown>(`/api/positions/${positionId}`, { stop_loss: null, target: null });
          } catch (e) {
            console.error('[TradeSheet] Error clearing target/SL for market exit:', e);
          }
          currentExitMode = true;
          currentLinkedPosId = positionId;
        } else {
          // User changed/updated pending exit instruction on the position (SL, SLM, TARGET, LIMIT, GTT)
          let positionUpdateData: any = {};
          if (resolvedOrderType === 'SL' || resolvedOrderType === 'SLM') {
            positionUpdateData = {
              stop_loss: resolvedTriggerPrice || resolvedStopLoss || null,
              target: null, // Clear target when switching to SL-only
            };
          } else if (resolvedOrderType === 'TARGET' || resolvedOrderType === 'LIMIT') {
            positionUpdateData = {
              target: resolvedClientPrice || resolvedTarget || null,
              stop_loss: null, // Clear stop loss when switching to Target-only
            };
          } else if (resolvedOrderType === 'GTT') {
            positionUpdateData = {
              stop_loss: resolvedStopLoss || resolvedTriggerPrice || null,
              target: resolvedTarget || null,
            };
          }

          try {
            await api.patch<unknown>(`/api/positions/${positionId}`, positionUpdateData);
            showToast('Position exit instruction updated successfully');
            onSuccess?.();
            onClose();
            return;
          } catch (err) {
            if (err instanceof ApiError) {
              showOrderError((err.details as any)?.error || 'Failed to update position exit instruction.');
            } else {
              showOrderError('Failed to update position exit instruction.');
            }
            return;
          }
        }
      }

      if (currentExitMode && !isModify) {
        // Exit mode: fire-and-forget for 0ms visual latency (removed blocking await)
        handedOffToOrderFlow = true;
        try {
          const activeQuoteObj = (isCrypto && bSymbol ? cryptoQuote : null) || (isComex && item?.comexSymbol ? comexQuotes[item.comexSymbol] : null) || activeKiteQuote || (fallbackQuoteObj ? {
            bid: fallbackQuoteObj.bid,
            ask: fallbackQuoteObj.ask,
            lastPrice: fallbackQuoteObj.last_price,
            time: Date.now()
          } as any : null);
          const diagnosticFields = {
            frontend_bid: activeQuoteObj?.bid,
            frontend_ask: activeQuoteObj?.ask,
            frontend_ltp: activeQuoteObj?.lastPrice ?? (activeQuoteObj as any)?.last_price ?? currentLtp,
            frontend_quote_time: activeQuoteObj?.time || (activeQuoteObj as any)?.timestamp || Date.now(),
            client_click_time: Date.now(),
          };

          const orderAttemptId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const orderPayload = {
            symbol: item.symbol,
            kite_instrument: computedKiteSymbol || item.symbol,
            segment: item.segment,
            side: placeSide,
            qty: finalQty,
            lots: finalLots,
            order_type: resolvedOrderType as any,
            product_type: ((currentLinkedPosId ? activePositions.find(p => p.id === currentLinkedPosId)?.product_type : undefined) || existingPos?.product_type || targetPT || 'INTRADAY') as 'INTRADAY' | 'CARRY',
            client_price: resolvedClientPrice ?? currentLtp,
            trigger_price: resolvedTriggerPrice,
            stop_loss: resolvedStopLoss,
            target: resolvedTarget,
            is_exit: true,
            linked_position_id: currentLinkedPosId || undefined,
            orderAttemptId,
            ...diagnosticFields,
          };

          handleCloseAnimation();

          placeOrder(orderPayload).then(res => {
            if (res.success || (res as any).isProcessing) {
              const isProcessing = Boolean((res as any).isProcessing);
              showToast(isProcessing ? `Order submitted for ${item.symbol}` : `${placeSide} order executed for ${item.symbol}`);
              window.dispatchEvent(new Event('order_placed'));
              window.dispatchEvent(new Event('position-closed'));
              if (onSuccess) {
                try {
                  onSuccess();
                } catch (e) {
                  console.error('onSuccess refresh failed', e);
                }
              }
              setTimeout(() => {
                window.dispatchEvent(new Event('order_placed'));
                window.dispatchEvent(new Event('position-closed'));
              }, 1500);
            } else {
              const errMsg = res.error || 'Order failed. Please try again.';
              window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
              window.dispatchEvent(new Event('order_failed'));
            }
          }).catch(err => {
            const errMsg = err.message || 'Order failed. Please try again.';
            window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
            window.dispatchEvent(new Event('order_failed'));
          });
        } catch (err: any) {
          const errMsg = err.message || 'Order failed. Please try again.';
          setOrderErrorMsg(errMsg);
          setOrderState('error');
          window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
          window.dispatchEvent(new Event('order_failed'));
        }
      } else {
        // Buy/Sell flow: fire-and-forget — no loader overlay shown.
        handedOffToOrderFlow = true;

        // Modify flow: update the pending order in place via PUT /api/orders/[id]
        if (isModify && modifyingOrderId && !modifyingOrderId.startsWith('pos-')) {
          try {
            const updatePayload = {
              price: resolvedClientPrice,
              trigger_price: resolvedTriggerPrice ?? null,
              stop_loss: resolvedStopLoss ?? null,
              target: resolvedTarget ?? null,
              qty: finalQty,
              lots: finalLots,
              order_type: resolvedOrderType,
              is_exit: initialOrder?.is_exit !== undefined ? Boolean(initialOrder.is_exit) : false,
              linked_position_id: currentLinkedPosId || initialOrder?.linked_position_id || initialOrder?.linkedPosId || null,
            };
            const res: any = await api.put(`/api/orders/${modifyingOrderId}`, updatePayload);
            if (res?.order) {
              updateOrderLocally(res.order);
            }
            window.dispatchEvent(new Event('global-loader-end'));
            window.dispatchEvent(new Event('order_placed'));
            showToast('Order modified successfully');
            if (onSuccess) {
              try {
                onSuccess();
              } catch (e) {
                console.error('onSuccess refresh failed', e);
              }
            }
            handleCloseAnimation();
            return;
          } catch (err: any) {
            const errMsg = (err instanceof ApiError ? (err.details as any)?.error : null) || err.message || 'Failed to modify order.';
            setOrderErrorMsg(errMsg);
            setOrderState('error');
            window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
            window.dispatchEvent(new Event('order_failed'));
            window.dispatchEvent(new Event('global-loader-end'));
            return;
          }
        }


        try {
          const activeQuoteObj = (isCrypto && bSymbol ? cryptoQuote : null) || (isComex && item?.comexSymbol ? comexQuotes[item.comexSymbol] : null) || activeKiteQuote || (fallbackQuoteObj ? {
            bid: fallbackQuoteObj.bid,
            ask: fallbackQuoteObj.ask,
            lastPrice: fallbackQuoteObj.last_price,
            time: Date.now()
          } as any : null);
          const diagnosticFields = {
            frontend_bid: activeQuoteObj?.bid,
            frontend_ask: activeQuoteObj?.ask,
            frontend_ltp: activeQuoteObj?.lastPrice ?? (activeQuoteObj as any)?.last_price ?? currentLtp,
            frontend_quote_time: activeQuoteObj?.time || (activeQuoteObj as any)?.timestamp || Date.now(),
            client_click_time: Date.now(),
          };

          const orderAttemptId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const orderPayload = {
            symbol: item.symbol,
            kite_instrument: computedKiteSymbol || item.symbol,
            segment: item.segment,
            side: placeSide,
            qty: finalQty,
            lots: finalLots,
            order_type: resolvedOrderType as any,
            product_type: productType,
            client_price: resolvedClientPrice ?? currentLtp,
            trigger_price: resolvedTriggerPrice,
            stop_loss: resolvedStopLoss,
            target: resolvedTarget,
            is_exit: (placeSide === 'BUY' && hasSellPos) || (placeSide === 'SELL' && hasBuyPos),
            linked_position_id: currentLinkedPosId || undefined,
            orderAttemptId,
            ...diagnosticFields,
          };

          showToast(`${placeSide} order sent for ${item.symbol}`);
          handleCloseAnimation();

          // Background execution for 0ms visual latency
          placeOrder(orderPayload).then(res => {
            if (res.success) {
              window.dispatchEvent(new Event('order_placed'));
              if (onSuccess) {
                try {
                  onSuccess();
                } catch (e) {
                  console.error('onSuccess refresh failed', e);
                }
              }
            } else {
              const errMsg = res.error || 'Order failed. Please try again.';
              window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
              window.dispatchEvent(new Event('order_failed'));
            }
          }).catch(err => {
            const errMsg = err.message || 'Order failed. Please try again.';
            window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
            window.dispatchEvent(new Event('order_failed'));
          }).finally(() => {
            window.dispatchEvent(new Event('global-loader-end'));
          });
        } catch (err: any) {
          const errMsg = err.message || 'Order failed. Please try again.';
          setOrderErrorMsg(errMsg);
          setOrderState('error');
          window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
          window.dispatchEvent(new Event('order_failed'));
          window.dispatchEvent(new Event('global-loader-end'));
        }
      }
    } catch (e) {
      console.error('[TradeSheet handlePlace] Unexpected exception:', e);
    } finally {
      isExecutingRef.current = false;
      setOrderState('idle');
    }
  };

  const fmt = (n: number) =>
    n > 0 ? `${currencySymbol}${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '---';

  return (
    <>
      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; visibility: hidden; }
          to { opacity: 1; visibility: visible; }
        }
        @keyframes slideUp {
          from { transform: translateY(100%) !important; }
          to { transform: translateY(0) !important; }
        }
        @keyframes scaleIn {
          from { transform: scale(0.95); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
        .ts2-overlay {
          position: fixed; inset: 0;
          background: rgba(0,0,0,0.55);
          z-index: 100000;
          opacity: 0; visibility: hidden;
          pointer-events: none;
          transition: opacity 0.3s ease, visibility 0.3s ease;
        }
        .ts2-overlay.active {
          opacity: 1; visibility: visible;
          pointer-events: auto;
          animation: fadeIn 0.3s ease forwards;
        }

        .ts2-sheet {
          position: fixed; top: 0; left: 0; right: 0; bottom: 0;
          width: 100%; max-width: 100%; margin: 0;
          background: var(--bg-body, #F5F7FB);
          z-index: 100001;
          transform: translateY(100%);
          display: flex; flex-direction: column;
          overflow: hidden;
          pointer-events: none;
        }
        .ts2-sheet.open {
          transform: translateY(0);
          animation: slideUp 0.38s cubic-bezier(0.25, 0.9, 0.35, 1.05) forwards;
          pointer-events: auto;
        }


        .ts2-header {
          background: var(--card-bg, #fff); padding: 10px 14px 12px;
          display: flex; align-items: center; gap: 12px;
          border-bottom: 1px solid var(--border-light, #EEF2F8); flex-shrink: 0;
        }
        .ts2-back-btn {
          width: 36px; height: 36px; border-radius: 50%;
          background: var(--icon-bg, #F1F5F9); border: none;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; color: var(--text-secondary, #374151); font-size: 0.9rem;
        }
        .ts2-name-block { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
        .ts2-instr-name {
          font-size: 1rem; font-weight: 800; color: var(--text-primary, #111827);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .ts2-segment-badge {
          display: inline-block; margin-top: 4px;
          font-size: 0.6rem; font-weight: 700;
          color: #B91C1C; background: rgba(185,28,28,0.1);
          padding: 2px 10px; border-radius: 30px;
        }
        body.dark .ts2-segment-badge {
          background: rgba(239,68,68,0.15); color: #EF4444;
        }
        
        .ts2-status-badge {
          display: inline-block;
          font-size: 0.6rem; font-weight: 700;
          padding: 2px 8px; border-radius: 30px;
          text-transform: uppercase; letter-spacing: 0.3px;
          margin-left: 6px;
        }
        .ts2-status-badge.neg {
          color: #B91C1C; background: rgba(185,28,28,0.1);
        }
        body.dark .ts2-status-badge.neg {
          color: #EF4444; background: rgba(239,68,68,0.15);
        }
        .ts2-status-badge.pos {
          color: #15803D; background: rgba(21,128,61,0.1);
        }
        body.dark .ts2-status-badge.pos {
          color: #22C55E; background: rgba(34,197,94,0.15);
        }
        .ts2-price-block { text-align: right; flex-shrink: 0; display: flex; flex-direction: column; justify-content: center; align-items: flex-end; }
        .ts2-price-value { font-size: 1.35rem; font-weight: 800; color: var(--text-primary, #111827); }
        .ts2-change-badge {
          display: inline-block; margin-top: 3px;
          font-size: 0.62rem; font-weight: 700;
          color: #15803D;
        }
        body.dark .ts2-change-badge {
          color: #22C55E;
        }
        .ts2-change-badge.neg { color: #B91C1C; }
        body.dark .ts2-change-badge.neg { color: #EF4444; }

        .ts2-bidask {
          background: var(--card-bg, #fff); display: flex; align-items: center;
          padding: 8px 16px; border-bottom: 1px solid var(--border-light, #EEF2F8); flex-shrink: 0;
          gap: 8px;
        }
        .ts2-ba-col {
          flex: 1; display: flex; flex-direction: row; align-items: center; gap: 8px;
        }
        .ts2-ba-col:last-child { justify-content: flex-end; }
        .ts2-ba-label {
          font-size: 0.6rem; font-weight: 700; color: var(--text-secondary, #6B7280);
          text-transform: uppercase; letter-spacing: 0.5px;
        }
        .ts2-ba-bid { font-size: 0.82rem; font-weight: 700; color: #15803D; }
        body.dark .ts2-ba-bid { color: #22C55E; }
        .ts2-ba-ask { font-size: 0.82rem; font-weight: 700; color: #B91C1C; }
        body.dark .ts2-ba-ask { color: #EF4444; }
        .ts2-ba-divider { width: 1px; height: 20px; background: var(--border-light, #E5E7EB); margin: 0 8px; }

        .ts2-scroll { flex: 1; overflow-y: auto; padding-bottom: 120px; -webkit-overflow-scrolling: touch; }
        .ts2-scroll::-webkit-scrollbar { display: none; }
        .ts2-body { padding: 12px; display: flex; flex-direction: column; gap: 12px; }

        .ts2-card {
          background: var(--card-bg, #fff); border-radius: 14px;
          padding: 12px 14px; border: 1px solid var(--border-light, #F1F5F9);
        }
        .ts2-label {
          font-size: 0.62rem; font-weight: 700; color: var(--text-secondary, #6B7280);
          text-transform: uppercase; letter-spacing: 0.4px; margin-bottom: 10px;
        }
        .ts2-unit-row { display: flex; align-items: center; justify-content: space-between; }
        .ts2-toggle {
          display: flex; background: var(--card-alt-bg, #F1F5F9); border-radius: 30px; padding: 3px; gap: 2px;
        }
        .ts2-toggle-opt {
          padding: 5px 16px; border-radius: 30px;
          font-size: 0.65rem; font-weight: 700; color: var(--text-secondary, #6B7280);
          cursor: pointer; border: none; background: transparent; transition: all 0.2s;
        }
        .ts2-toggle-opt.active {
          background: var(--card-bg, #FFFFFF); color: var(--text-primary, #111827);
          box-shadow: 0 1px 4px rgba(0,0,0,0.1);
        }

        .ts2-info-wrap { background: var(--card-alt-bg, #F1F5F9); border-radius: 14px; padding: 8px; }
        .ts2-info-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 6px; }
        .ts2-info-card { background: var(--card-bg, #fff); border-radius: 10px; padding: 8px 6px; text-align: center; }
        .ts2-ic-label {
          font-size: 0.55rem; font-weight: 600; color: var(--text-secondary, #6B7280);
          text-transform: uppercase; margin-bottom: 4px;
        }
        .ts2-ic-val { font-size: 0.82rem; font-weight: 800; color: var(--text-primary, #111827); }

        .ts2-stepper {
          display: flex; align-items: center;
          background: var(--card-bg, #F8FAFF); border: 1.5px solid var(--border-light, #E5E7EB);
          border-radius: 50px; overflow: hidden; height: 52px;
        }
        .ts2-qty-btn {
          width: 52px; height: 52px; flex-shrink: 0;
          border: none; background: transparent;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer; font-size: 1rem; color: var(--text-primary, #374151); border-radius: 50%;
        }
        .ts2-qty-btn:active { background: var(--card-alt-bg, #E5E7EB); }
        .ts2-qty-val {
          flex: 1; text-align: center; font-size: 1.25rem; font-weight: 800;
          color: var(--text-primary, #111827); border: none; background: transparent; outline: none;
          font-family: inherit; min-width: 0;
          -moz-appearance: textfield;
        }
        .ts2-qty-val::-webkit-outer-spin-button,
        .ts2-qty-val::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
        .ts2-qty-hint { font-size: 0.6rem; color: var(--text-muted, #9CA3AF); margin-top: 7px; text-align: center; }

        .ts2-pills { display: flex; gap: 6px; flex-wrap: wrap; }
        .ts2-pill {
          flex: 1; min-width: 60px; padding: 8px 4px; border-radius: 50px;
          font-size: 0.65rem; font-weight: 700; text-align: center; cursor: pointer;
          border: 1.5px solid var(--border-light, #E5E7EB); background: var(--card-bg, #fff); color: var(--text-primary, #374151);
          transition: all 0.18s; white-space: nowrap;
        }
        .ts2-sheet--buy .ts2-pill.active {
          background: #15803D; color: #fff; border-color: #15803D;
          box-shadow: 0 2px 8px rgba(21,128,61,0.25);
        }
        .ts2-sheet--sell .ts2-pill.active {
          background: #C62E2E; color: #fff; border-color: #C62E2E;
          box-shadow: 0 2px 8px rgba(198,46,46,0.25);
        }

        .ts2-price-input {
          width: 100%; box-sizing: border-box; border-radius: 12px;
          padding: 12px 14px; font-size: 1rem; font-weight: 700;
          border: 1.5px solid var(--border-light, #E5E7EB); background: var(--card-bg, #F8FAFF);
          color: var(--text-primary, #111827); outline: none; margin-top: 10px; font-family: inherit;
        }

        .ts2-field-input {
          width: 100%; box-sizing: border-box;
          background: var(--card-bg, #FFFFFF);
          border: 1px solid var(--border-light, #DCE3EC);
          border-radius: 12px;
          padding: 10px 12px;
          font-size: 0.9rem;
          font-weight: 700;
          color: var(--text-primary, #1A1E2B);
          outline: none;
          transition: border-color 0.2s;
          font-family: inherit;
        }
        .ts2-sheet--buy .ts2-field-input:focus {
          border-color: #15803D;
          box-shadow: 0 0 0 2px rgba(21,128,61,0.1);
        }
        .ts2-sheet--sell .ts2-field-input:focus {
          border-color: #C62E2E;
          box-shadow: 0 0 0 2px rgba(198,46,46,0.1);
        }

        .ts2-margin-card {
          background: var(--card-bg, #fff); border-radius: 14px; border: 1px solid var(--border-light, #F1F5F9); overflow: hidden;
        }
        .ts2-margin-row {
          display: flex; justify-content: space-between; align-items: center; padding: 11px 14px;
        }
        .ts2-margin-row + .ts2-margin-row { border-top: 1px solid var(--border-light, #F1F5F9); }
        .ts2-ml { font-size: 0.68rem; font-weight: 600; color: var(--text-secondary, #6B7280); }
        .ts2-mv { font-size: 0.78rem; font-weight: 700; color: var(--text-primary, #111827); }
        .ts2-mv-avail {
          color: #15803D;
          font-size: 0.72rem; font-weight: 700;
        }
        body.dark .ts2-mv-avail {
          color: #22C55E;
        }

        .ts2-footer {
          position: sticky; bottom: 0; left: 0; right: 0;
          width: 100%; max-width: 500px; margin: 0 auto; z-index: 10001;
          background: var(--card-bg, #fff);
          padding: 12px 14px calc(28px + env(safe-area-inset-bottom, 0px));
          display: flex; flex-direction: column; gap: 8px;
          border-top: 1px solid var(--border-light, #EEF2F8);
          box-shadow: 0 -4px 16px rgba(0,0,0,0.12);
          flex-shrink: 0;
        }
        @media (max-width: 500px) { .ts2-footer { max-width: 100%; } }
        .ts2-btn-row { display: flex; gap: 8px; width: 100%; }
        .ts2-btn {
          flex: 1; height: 52px; border: none; border-radius: 50px;
          font-size: 1rem; font-weight: 800; letter-spacing: 0.5px;
          cursor: pointer; display: flex; align-items: center; justify-content: center;
          transition: transform 0.15s;
        }
        .ts2-btn:active { transform: scale(0.96); }
        .ts2-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .ts2-btn-buy { background: #15803D; color: #fff; box-shadow: 0 6px 16px rgba(21,128,61,0.35); }
        .ts2-btn-sell { background: #B91C1C; color: #fff; box-shadow: 0 6px 16px rgba(185,28,28,0.35); }

        .ts2-toast {
          position: fixed; bottom: 90px; left: 50%; transform: translateX(-50%) translateY(20px);
          background: #2C313F; color: #F8FAFC; padding: 10px 22px; border-radius: 30px;
          border: 1px solid rgba(255, 255, 255, 0.18);
          font-size: 0.82rem; font-weight: 600; z-index: 10002;
          opacity: 0; transition: opacity 0.3s, transform 0.3s;
          white-space: nowrap; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
          backdrop-filter: blur(10px);
        }
        .ts2-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

        @media (min-width: 1024px) {
          .ts2-overlay {
            position: fixed !important; top: 0 !important; bottom: 0 !important;
            left: var(--sidebar-width, 260px) !important; right: 0 !important;
            width: calc(100% - var(--sidebar-width, 260px)) !important;
          }
          .ts2-sheet {
            position: fixed !important; top: 0 !important; bottom: 0 !important;
            height: 100vh !important; max-height: 100vh !important;
            left: var(--sidebar-width, 260px) !important; right: 0 !important;
            width: calc(100% - var(--sidebar-width, 260px)) !important; max-width: 100% !important;
            margin: 0 !important; border-radius: 0 !important;
            transform: translateY(100%) !important; box-shadow: 0 -10px 30px rgba(0,0,0,0.2) !important;
          }
          .ts2-sheet.open { transform: translateY(0) !important; }
          .ts2-footer { left: 0; right: 0; width: 100%; max-width: 100% !important; margin: 0; border-radius: 0; }
        }
      `}</style>

      <div id="tradeSheetOverlay" className={`ts2-overlay${(isOpen && !isClosing) ? ' active' : ''}`} onClick={handleCloseAnimation} />

      <div id="tradeSheet" className={`ts2-sheet${(isOpen && !isClosing) ? ' open' : ''}${effectiveExitMode ? ' ts2-exit-mode' : ''} ts2-sheet--${(activeSide === 'SELL' || effectiveExitMode) ? 'sell' : 'buy'}`}>
        {item && (
          <>
            {/* Header */}
            <div className="ts2-header">
              <button className="ts2-back-btn" onClick={handleCloseAnimation}>
                <i className="fas fa-chevron-down" />
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Row 1: Name + Price */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div className="ts2-instr-name">{fmtSymbolName(item.symbol, item.name)}</div>
                  <div className="ts2-price-value" style={{ flexShrink: 0, marginLeft: '12px' }}>
                    <TickFlash value={currentLtp}>{fmt(currentLtp)}</TickFlash>
                  </div>
                </div>
                {/* Row 2: Badge + Change% */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '3px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {effectiveExitMode && (
                      <span className="ts2-status-badge neg">Exit Position</span>
                    )}
                    {!effectiveExitMode && isFromPositions && (
                      <span className="ts2-status-badge pos">Add More</span>
                    )}
                  </div>
                  <span className={`ts2-change-badge${(item.change || '').startsWith('-') ? ' neg' : ''}`}>
                    {item.change || '0.00%'}
                  </span>
                </div>
              </div>
            </div>

            {/* Bid / Ask */}
            <div className="ts2-bidask">
              <div className="ts2-ba-col">
                <span className="ts2-ba-label">BID</span>
                <span className="ts2-ba-bid">
                  {currentLtp > 0 ? <TickFlash value={bidPrice}>{fmt(bidPrice)}</TickFlash> : '--'}
                </span>
              </div>
              <div className="ts2-ba-divider" />
              <div className="ts2-ba-col" style={{ alignItems: 'flex-end' }}>
                <span className="ts2-ba-label">ASK</span>
                <span className="ts2-ba-ask">
                  {currentLtp > 0 ? fmt(askPrice) : '--'}
                </span>
              </div>
            </div>

            <div className="ts2-scroll">
              <div className="ts2-body">

                {/* Order Unit */}
                <div className="ts2-card">
                  <div className="ts2-unit-row">
                    <span className="ts2-label" style={{ marginBottom: 0 }}>Order Unit</span>
                    <div className="ts2-toggle">
                      <button
                        className={`ts2-toggle-opt${orderUnit === 'qty' ? ' active' : ''}`}
                        onClick={() => {
                          if (orderUnit !== 'qty') {
                            setOrderUnit('qty');
                            const newQty = orderQty * (lotSize > 0 ? lotSize : 1);
                            setOrderQty(newQty);
                            setQtyInput(String(newQty));
                          }
                        }}
                      >QTY</button>
                      <button
                        className={`ts2-toggle-opt${orderUnit === 'lot' ? ' active' : ''}`}
                        onClick={() => {
                          if (orderUnit !== 'lot') {
                            setOrderUnit('lot');
                            const newLots = lotSize > 0 ? (orderQty / lotSize) : orderQty;
                            const formattedLots = parseFloat(newLots.toFixed(4));
                            setOrderQty(formattedLots);
                            setQtyInput(String(formattedLots));
                          }
                        }}
                      >LOT</button>
                    </div>
                  </div>
                </div>

                {/* Info cards */}
                <div className="ts2-info-wrap">
                  <div className="ts2-info-grid">
                    <div className="ts2-info-card">
                      <div className="ts2-ic-label">Lot Size</div>
                      <div className="ts2-ic-val">{lotSize}</div>
                    </div>
                    <div className="ts2-info-card">
                      <div className="ts2-ic-label">Max Lots</div>
                      <div className="ts2-ic-val">
                        {segSetting?.max_order_lot ?? segSetting?.max_lot ?? '--'}
                        {(segSetting?.max_order_lot ?? segSetting?.max_lot) && lotSize > 1
                          ? <span style={{ fontSize: '0.7em', color: 'var(--text-secondary)', marginLeft: 3 }}>({(segSetting.max_order_lot ?? segSetting.max_lot) * lotSize} qty)</span>
                          : null}
                      </div>
                    </div>
                    <div className="ts2-info-card">
                      <div className="ts2-ic-label">Order Lots</div>
                      <div className="ts2-ic-val">{orderUnit === 'lot' ? orderQty : Number((orderQty / lotSize).toFixed(4))}</div>
                    </div>
                    <div className="ts2-info-card">
                      <div className="ts2-ic-label">Total Qty</div>
                      <div className="ts2-ic-val">{Number(totalQty.toFixed(4))}</div>
                    </div>
                  </div>
                </div>

                {/* Quantity stepper */}
                <div className="ts2-card">
                  <div className="ts2-label">{orderUnit === 'lot' ? 'Lot' : 'Quantity'}</div>
                  <div className="ts2-stepper">
                    <button className="ts2-qty-btn" onClick={() => stepQty(-1)}>
                      <i className="fas fa-minus" />
                    </button>
                    <input
                      className="ts2-qty-val"
                      type="text"
                      inputMode="decimal"
                      value={qtyInput}
                      onChange={e => handleQtyChange(e.target.value)}
                      onBlur={() => {
                        const n = parseFloat(qtyInput);
                        if (!qtyInput || isNaN(n) || n <= 0) {
                          setQtyInput(String(orderQty));
                        } else {
                          const snapped = Math.max(0.0001, n);
                          setQtyInput(String(snapped));
                          setOrderQty(snapped);
                        }
                      }}
                    />
                    <button className="ts2-qty-btn" onClick={() => stepQty(1)}>
                      <i className="fas fa-plus" />
                    </button>
                  </div>
                  <div className="ts2-qty-hint">{orderUnit === 'lot' ? `${orderQty} Lots` : `${orderQty} Qty`}</div>
                  {qtyError && (
                    <div style={{ color: '#ef4444', fontSize: '0.68rem', fontWeight: 700, marginTop: '6px', textAlign: 'center' }}>
                      {qtyError}
                    </div>
                  )}
                </div>

                {/* Order Type */}
                <div className="ts2-card">
                  <div className="ts2-label">Order Type</div>
                  <div className="ts2-pills">
                    {(() => {
                      // GTT modification: show lifecycle-stage-aware options based on effectiveExitMode
                      const isModifyingGttOrder = isModify && initialOrder?.order_type === 'GTT';
                      if (isModifyingGttOrder) {
                        return effectiveExitMode
                          ? ['MARKET', 'TARGET', 'SL', 'GTT']
                          : ['MARKET', 'LIMIT', 'SLM', 'GTT'];
                      }
                      // Explicitly show exit-mode options for SL modifications
                      if (isModify && initialOrder?.order_type === 'SL') {
                        return ['MARKET', 'TARGET', 'SL', 'GTT'];
                      }
                      // When modifying a pending entry order (not an exit), show the same
                      // entry-mode options as a fresh order (MARKET, LIMIT, SLM, GTT).
                      if (isModify && initialOrder && !effectiveExitMode) {
                        return ['MARKET', 'LIMIT', 'SLM', 'GTT'];
                      }
                      return effectiveExitMode ? ['MARKET', 'TARGET', 'SL', 'GTT'] : ['MARKET', 'LIMIT', 'SLM', 'GTT'];
                    })().map(t => (
                      <button
                        key={t}
                        className={`ts2-pill${orderType === t ? ' active' : ''}`}
                        onClick={() => {
                          setOrderType(t);
                          if (t === 'GTT') {
                            setGttSubOption(effectiveExitMode ? 'TARGET' : 'LIMIT');
                          }
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* LIMIT / TARGET — Price input (separate card, matches watchlist) */}
                {(orderType === 'LIMIT' || orderType === 'TARGET') && (
                  <div className="ts2-card">
                    <div className="ts2-label">{orderType === 'TARGET' ? 'Target Price' : 'Price'} <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></div>
                    <input
                      className="ts2-field-input"
                      type="number"
                      placeholder="0.00"
                      value={limitPrice}
                      onChange={e => setLimitPrice(e.target.value)}
                    />
                    {priceRangeHelp}
                  </div>
                )}

                {/* SL / SLM — Price input */}
                {(orderType === 'SL' || orderType === 'SLM') && (
                  <div className="ts2-card">
                    <div className="ts2-label">
                      {orderType === 'SLM'
                        ? <>Stop Loss Price <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol}) {activeSide === 'BUY' ? 'trigger below' : 'trigger above'} Ltp</span></>
                        : (effectiveExitMode
                          ? <>Stop Loss <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol}) order executes at market price</span></>
                          : <>Trigger Price <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></>)
                      }
                    </div>
                    <input
                      className="ts2-field-input"
                      type="number"
                      placeholder="0.00"
                      value={triggerPrice}
                      onChange={e => setTriggerPrice(e.target.value)}
                    />
                    {priceRangeHelp}
                  </div>
                )}

                {/* GTT — Stop Loss / Target / Limit sub-options */}
                {orderType === 'GTT' && (
                  <div className="ts2-card">
                    {effectiveExitMode ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div className="ts2-label" style={{ marginBottom: 0 }}>SL / TARGET</div>
                        <div style={{ display: 'flex', gap: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <div className="ts2-label" style={{ marginBottom: 6 }}>Stop Loss <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></div>
                            <input
                              className="ts2-field-input"
                              type="number"
                              placeholder="0.00"
                              value={slPrice}
                              onChange={e => setSlPrice(e.target.value)}
                            />
                            {currentLtp > 0 && (
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary, #6B7280)', marginTop: 4, fontWeight: 600 }}>
                                {isLongPosition
                                  ? `less than ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `more than ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                              </div>
                            )}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div className="ts2-label" style={{ marginBottom: 6 }}>Target <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></div>
                            <input
                              className="ts2-field-input"
                              type="number"
                              placeholder="0.00"
                              value={tpPrice}
                              onChange={e => setTpPrice(e.target.value)}
                            />
                            {currentLtp > 0 && (
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary, #6B7280)', marginTop: 4, fontWeight: 600 }}>
                                {isLongPosition
                                  ? `more than ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `less than ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <div className="ts2-label" style={{ marginBottom: 0 }}>SL / LIMIT / TARGET</div>
                        <div style={{ display: 'flex', gap: '12px' }}>
                          <div style={{ flex: 1 }}>
                            <div className="ts2-label" style={{ marginBottom: 6 }}>Stop Loss <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></div>
                            <input
                              className="ts2-field-input"
                              type="number"
                              placeholder="0.00"
                              value={slPrice}
                              onChange={e => setSlPrice(e.target.value)}
                            />
                            {(() => {
                              const parsedLimit = parseFloat(limitPrice);
                              const refPrice = (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit : currentLtp;
                              if (refPrice <= 0) return null;
                              const labelSuffix = (!isNaN(parsedLimit) && parsedLimit > 0) ? ' (limit)' : '';
                              return (
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary, #6B7280)', marginTop: 4, fontWeight: 600 }}>
                                  {isLongPosition
                                    ? `less than ${currencySymbol}${refPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${labelSuffix}`
                                    : `more than ${currencySymbol}${refPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${labelSuffix}`}
                                </div>
                              );
                            })()}
                          </div>
                          <div style={{ flex: 1 }}>
                            <div className="ts2-label" style={{ marginBottom: 6 }}>Target <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></div>
                            <input
                              className="ts2-field-input"
                              type="number"
                              placeholder="0.00"
                              value={tpPrice}
                              onChange={e => setTpPrice(e.target.value)}
                            />
                            {(() => {
                              const parsedLimit = parseFloat(limitPrice);
                              const refPrice = (!isNaN(parsedLimit) && parsedLimit > 0) ? parsedLimit : currentLtp;
                              if (refPrice <= 0) return null;
                              const labelSuffix = (!isNaN(parsedLimit) && parsedLimit > 0) ? ' (limit)' : '';
                              return (
                                <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary, #6B7280)', marginTop: 4, fontWeight: 600 }}>
                                  {isLongPosition
                                    ? `more than ${currencySymbol}${refPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${labelSuffix}`
                                    : `less than ${currencySymbol}${refPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${labelSuffix}`}
                                </div>
                              );
                            })()}
                          </div>
                        </div>
                        <div>
                          <div className="ts2-label" style={{ marginBottom: 6 }}>{activeSide === 'SELL' ? 'Sell at Limit' : 'Buy at Limit'} <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></div>
                          <input
                            className="ts2-field-input"
                            type="number"
                            placeholder="0.00"
                            value={limitPrice}
                            onChange={e => setLimitPrice(e.target.value)}
                          />
                          {priceRangeHelp}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Product Type */}
                {!effectiveExitMode && (
                  <div className="ts2-card">
                    <div className="ts2-label">Product Type</div>
                    <div className="ts2-pills">
                      {(['INTRADAY', 'CARRY'] as ProductType[]).map(p => (
                        <button key={p} className={`ts2-pill${productType === p ? ' active' : ''}`} onClick={() => setProductType(p)}>{p}</button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Margin */}
                <div className="ts2-margin-card">
                  <div className="ts2-margin-row">
                    <span className="ts2-ml">Available</span>
                    <span className="ts2-mv-avail">
                      {`${currencySymbol} ${availableBalance.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </span>
                  </div>
                  <div className="ts2-margin-row">
                    <span className="ts2-ml">Required Margin</span>
                    <span className="ts2-mv">{currencySymbol} {requiredMargin.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="ts2-margin-row">
                    <span className="ts2-ml">Equity</span>
                    <span className="ts2-mv" style={{ color: 'var(--text-primary, #111827)', fontWeight: 800 }}>
                      {currencySymbol} {baseExposure.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>

                  {/* Collapsible Charges Breakdown */}
                  <div
                    className="ts2-margin-row"
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    onClick={() => setShowCharges(!showCharges)}
                  >
                    <span className="ts2-ml" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontWeight: 700 }}>
                      Charges Breakdown {showCharges ? '▲' : '▼'}
                    </span>
                    <span className="ts2-mv" style={{ color: (activeSide === 'SELL' || effectiveExitMode) ? '#C62E2E' : '#15803D', fontWeight: 800 }}>
                      {currencySymbol} {displayBrokerage.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  {showCharges && (
                    <>
                      <div className="ts2-margin-row" style={{ paddingTop: '8px' }}>
                        <span className="ts2-ml">
                          Intraday Brokerage
                        </span>
                        <span className="ts2-mv" style={displayIntraday > 0 ? {} : { opacity: 0.4 }}>
                          {currencySymbol} {displayIntraday.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="ts2-margin-row">
                        <span className="ts2-ml">Carry Charges</span>
                        <span className="ts2-mv" style={displayCarry > 0 ? { color: (activeSide === 'SELL' || effectiveExitMode) ? '#C62E2E' : '#15803D', fontWeight: 700 } : { opacity: 0.4 }}>
                          {currencySymbol} {displayCarry.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="ts2-margin-row">
                        <span className="ts2-ml">GTT Charges</span>
                        <span className="ts2-mv" style={displayGtt > 0 ? { color: (activeSide === 'SELL' || effectiveExitMode) ? '#C62E2E' : '#15803D', fontWeight: 700 } : { opacity: 0.4 }}>
                          {currencySymbol} {displayGtt.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                    </>
                  )}
                </div>

                <div style={{ height: 8 }} />
              </div>
            </div>

            {/* Footer */}
            <div className="ts2-footer">
              {isExpired ? (
                <div style={{ padding: '8px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderRadius: '8px', fontSize: '13px', fontWeight: '500', textAlign: 'center', width: '100%' }}>
                  This instrument has expired.
                </div>
              ) : isSpotIndex ? (
                <div style={{ padding: '12px', background: 'rgba(239,68,68,0.1)', color: '#ef4444', borderRadius: '8px', fontSize: '13.5px', fontWeight: '600', textAlign: 'center', width: '100%', lineHeight: '1.4' }}>
                  Indices cannot be traded directly.<br />
                  <span style={{ fontSize: '12px', fontWeight: '500', opacity: 0.9 }}>Please trade their Futures or Options.</span>
                </div>
              ) : null}

              {!isSpotIndex && (() => {
                // Button label: show lots when in LOT mode, qty when in QTY mode
                let actionText: string;
                if (orderUnit === 'lot') {
                  const formattedLots = Number.isInteger(orderQty) ? orderQty : orderQty.toFixed(2);
                  actionText = `${formattedLots} LOT${orderQty !== 1 ? 'S' : ''}`;
                } else {
                  actionText = `${orderQty} QTY`;
                }

                const buyPriceLabel = askPrice > 0 ? ` @ ${fmt(askPrice)}` : '';
                const sellPriceLabel = bidPrice > 0 ? ` @ ${fmt(bidPrice)}` : '';

                return (
                  <div className="ts2-btn-row">
                    {(side === 'SELL' || side === 'BOTH') && (
                      <button
                        className="ts2-btn ts2-btn-sell"
                        disabled={isBusy || isExpired}
                        style={(isBusy || isExpired) ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                        onClick={() => handlePlace('SELL')}
                      >
                        {isModify ? 'MODIFY' : effectiveExitMode ? (['TARGET', 'SL', 'GTT'].includes(orderType) ? 'MODIFY POSITION' : 'EXIT POSITION') : hideLotText ? 'SELL' : `SELL ${actionText}${sellPriceLabel}`}
                      </button>
                    )}
                    {(side === 'BUY' || side === 'BOTH') && (
                      <button
                        className={`ts2-btn${effectiveExitMode ? ' ts2-btn-sell' : ' ts2-btn-buy'}`}
                        disabled={isBusy || isExpired}
                        style={(isBusy || isExpired) ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                        onClick={() => handlePlace('BUY')}
                      >
                        {isModify ? 'MODIFY' : effectiveExitMode ? (['TARGET', 'SL', 'GTT'].includes(orderType) ? 'MODIFY POSITION' : 'EXIT POSITION') : hideLotText ? 'BUY' : `BUY ${actionText}${buyPriceLabel}`}
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>

      <div className={`ts2-toast${toast ? ' show' : ''}`} onClick={() => setToast(null)} style={{ cursor: 'pointer' }}>{toast}</div>
    </>
  );
};

