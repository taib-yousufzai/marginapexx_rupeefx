'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useOrderEntry, OrderType, ProductType } from '@/hooks/useOrderEntry';
import { parseOptionSymbol } from '@/lib/parseOptionSymbol';
import AnimatedLoader from '@/components/AnimatedLoader';

import { supabase } from '@/lib/supabaseClient';
import { api, ApiError } from '@/lib/api';
import { useActivePositions } from '@/hooks/useActivePositions';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { useComexQuotes } from '@/hooks/useComexQuotes';
import { calculateMarginPortion } from '@/lib/trading/MarginCalculator';
import { ErrorModal } from '@/components/ErrorModal';
import { useTradeConfig } from '@/contexts/TradeConfigContext';
import { useBalance } from '@/hooks/useBalance';
import { mapSegmentWithSymbol } from '@/lib/trading/SymbolMapping';
import { resolveEffectivePrices } from '@/lib/trading/marketPriceResolver';
import type { TradingInstrument } from '@/lib/types/instrument';

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
  const { placeOrder, loading: placingOrder } = useOrderEntry();

  const [isClosing, setIsClosing] = useState(false);
  const handleCloseAnimation = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 380); // match CSS transition time exactly to prevent blank white page sliding down
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
  const orderError   = orderState === 'error' ? orderErrorMsg : null;
  // isBusy gates the BUY/SELL footer buttons â€” also checks the hook's own loading flag
  const isBusy = placingOrder || isSubmitting;
  const isExpired = useMemo(() => {
    if (!item?.expiry || exitMode || isModify) return false;
    const expiryDate = new Date(item.expiry);
    const now = new Date();
    expiryDate.setUTCHours(0, 0, 0, 0);
    now.setUTCHours(0, 0, 0, 0);
    return expiryDate < now;
  }, [item?.expiry, exitMode, isModify]);

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
  const currencySymbol = '₹';
  const [showCharges, setShowCharges] = useState(false);

  const { positions: activePositions, refreshPositions } = useActivePositions();

  const isOpen = !!item;
  const rawLotSize = item ? Number((item as any).lot_size || (item as any).lotSize || 0) : 0;
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
    : (dbSeg.toUpperCase().includes('COMEX') || !!item?.comexSymbol);

  let bSymbol = item?.binanceSymbol || (item && isCrypto && item.symbol ? item.symbol.replace('/', '') : '');
  if (bSymbol && !bSymbol.endsWith('USDT')) {
    bSymbol = bSymbol + 'USDT';
  }
  const computedKiteSymbol = useMemo(() => {
    let k = item?.kiteSymbol;
    if (k && item?.symbol) {
      const isOption = item.symbol.endsWith('CE') || item.symbol.endsWith('PE');
      if (isOption && (!k.includes(':') || (!k.endsWith('CE') && !k.endsWith('PE')))) {
        const underlying = item.symbol.replace(/_INDEX|NSE:|INDEX/g, '').trim();
        let prefix = 'NFO';
        if (underlying.includes('SENSEX') || underlying.includes('BANKEX')) prefix = 'BFO';
        else if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS'].some(x => underlying.includes(x))) prefix = 'MCX';
        k = `${prefix}:${item.symbol}`;
      }
    }
    return k;
  }, [item?.kiteSymbol, item?.symbol]);

  const marketSymbols = useMemo(() => {
    const list: string[] = [];
    if (computedKiteSymbol) list.push(computedKiteSymbol);
    if (isCrypto && item?.symbol) {
      list.push(item.symbol.replace('/', ''));
    }
    if (bSymbol) {
      list.push(bSymbol);
    }
    return list;
  }, [computedKiteSymbol, isCrypto, item?.symbol, bSymbol]);

  const comexSymbols = useMemo(() => {
    if (item?.comexSymbol) return [item.comexSymbol];
    return [];
  }, [item?.comexSymbol]);

  const { quotes: marketQuotes } = useMarketQuotes(marketSymbols);
  const { quotes: comexQuotes } = useComexQuotes(comexSymbols);

  let currentLtp = typeof item?.price === 'string'
    ? parseFloat((item.price as string).replace(/,/g, ''))
    : (item?.price ?? 0);
  let currentChangePercent = parseFloat(item?.change?.replace(/[%+]/g, '') || '0') || 0;

  const symCheck = ((item?.symbol || '') + ' ' + (item?.name || '') + ' ' + (item?.kiteSymbol || '')).toUpperCase();
  const isForexUsd = symCheck.includes('GBPUSD') || symCheck.includes('EURUSD') || symCheck.includes('GBP/USD') || symCheck.includes('EUR/USD');
  const usdInrRate = 83.85;

  const cryptoQuote = isCrypto && bSymbol ? (marketQuotes[bSymbol] || marketQuotes[item?.symbol?.replace('/', '') || '']) : null;

  if (isCrypto && bSymbol && cryptoQuote) {
    currentLtp = cryptoQuote.lastPrice || currentLtp;
    const prevClose = (cryptoQuote as any).prevClosePrice ?? (cryptoQuote as any).close ?? currentLtp;
    currentChangePercent = (cryptoQuote as any).changePercent ?? (prevClose > 0 ? ((currentLtp - prevClose) / prevClose) * 100 : 0);
  } else if (isComex && item?.comexSymbol && comexQuotes[item.comexSymbol]) {
    currentLtp = comexQuotes[item.comexSymbol].lastPrice;
    currentChangePercent = comexQuotes[item.comexSymbol].changePercent;
  } else if (computedKiteSymbol && marketQuotes[computedKiteSymbol]) {
    currentLtp = marketQuotes[computedKiteSymbol].lastPrice;
    currentChangePercent = marketQuotes[computedKiteSymbol].changePercent;
  } else if (item?.symbol && marketQuotes[item.symbol]) {
    currentLtp = marketQuotes[item.symbol].lastPrice;
    currentChangePercent = marketQuotes[item.symbol].changePercent;
  }

  if (isForexUsd && currentLtp > 0 && currentLtp < 20) {
    currentLtp *= usdInrRate;
  }

  // Fallback: if still no price and comexSymbol exists, use COMEX USD price
  if (currentLtp === 0 && item?.comexSymbol && comexQuotes[item.comexSymbol]) {
    currentLtp = comexQuotes[item.comexSymbol].lastPrice;
    currentChangePercent = comexQuotes[item.comexSymbol].changePercent;
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
    } else if (computedKiteSymbol && marketQuotes[computedKiteSymbol]) {
      rawBid = marketQuotes[computedKiteSymbol].bid || currentLtp;
      rawAsk = marketQuotes[computedKiteSymbol].ask || currentLtp;
    } else if (item?.symbol && marketQuotes[item.symbol]) {
      rawBid = marketQuotes[item.symbol].bid || currentLtp;
      rawAsk = marketQuotes[item.symbol].ask || currentLtp;
    }

    if (!rawBid || rawBid <= 0) rawBid = currentLtp;
    if (!rawAsk || rawAsk <= 0) rawAsk = currentLtp;

    if (isForexUsd) {
      if (rawBid > 0 && rawBid < 20) rawBid *= usdInrRate;
      if (rawAsk > 0 && rawAsk < 20) rawAsk *= usdInrRate;
    }

    const isIndianMarket = !isCrypto && !isComex;

    const activeAskBuffer = isIndianMarket ? 0 : (buyEntryBuffer || buySetting?.bid_buffer || 0.3);
    const activeBidBuffer = isIndianMarket ? 0 : (sellEntryBuffer || sellSetting?.bid_buffer || 0.3);

    const effective = resolveEffectivePrices({
      ltp: currentLtp,
      rawBid,
      rawAsk,
      hasRealBidAsk: Boolean(rawBid && rawAsk && rawBid < rawAsk),
      askBuffer: activeAskBuffer,
      bidBuffer: activeBidBuffer,
    });

    if (exitMode) {
      bidPrice = effective.effectiveBid * (1 - buyExitBuffer / 100);
      askPrice = effective.effectiveAsk * (1 + sellExitBuffer / 100);
    } else {
      bidPrice = effective.effectiveBid;
      askPrice = effective.effectiveAsk;
    }
  }

  const priceOfScript = activeSide === 'SELL' ? rawBid : rawAsk;

  const intradayLeverage = segSetting?.intraday_leverage ?? 10;
  const holdingLeverage = segSetting?.holding_leverage ?? 10;
  const leverage = productType === 'CARRY' ? holdingLeverage : intradayLeverage;

  const totalQty = orderUnit === 'lot' ? orderQty * lotSize : orderQty;
  const effectivePrice = side === 'SELL' ? bidPrice : askPrice;
  // Compute individual charge amounts for display
  const chargePrice = (orderType === 'LIMIT' || orderType === 'GTT') && limitPrice && !isNaN(parseFloat(limitPrice))
    ? parseFloat(limitPrice) : (currentLtp > 0 ? currentLtp : 0);
  const chargeQty = orderUnit === 'lot' ? orderQty * lotSize : orderQty;
  const chargeExposure = chargeQty * chargePrice;

  const computeCharge = (commType: string, commVal: number) => {
    if (commType === 'Per Crore') return (chargeExposure * commVal) / 10000000;
    if (commType === 'Per Lot') return (chargeQty / lotSize) * commVal;
    if (commType === 'Per Trade' || commType === 'Flat') return commVal;
    return chargeExposure * 0.001;
  };
  const anyPosForSymbol = activePositions.find(p => (p.symbol === item?.symbol || (item?.symbol && (p.symbol?.includes(item.symbol) || item.symbol.includes(p.symbol)))) && ((p.status as string) === 'open' || (p.status as string) === 'OPEN' || (p.status as string) === 'active'));
  const effectiveProductType = propProductType || (linkedPosId ? activePositions.find(p => p.id === linkedPosId)?.product_type : undefined) || (exitMode && anyPosForSymbol ? anyPosForSymbol.product_type : undefined) || productType;
  const targetPT = effectiveProductType as 'INTRADAY' | 'CARRY';
  const existingPos = activePositions.find(p => (p.symbol === item?.symbol || (item?.symbol && (p.symbol?.includes(item.symbol) || item.symbol.includes(p.symbol)))) && ((p.status as string) === 'open' || (p.status as string) === 'OPEN' || (p.status as string) === 'active') && p.product_type === targetPT) || anyPosForSymbol;
  // Total qty across all open lots for this symbol+product_type (for multi-lot exit validation)
  const totalOpenQtyForSymbol = activePositions
    .filter(p => (p.symbol === item?.symbol || (item?.symbol && (p.symbol?.includes(item.symbol) || item.symbol.includes(p.symbol)))) && ((p.status as string) === 'open' || (p.status as string) === 'OPEN' || (p.status as string) === 'active') && p.product_type === targetPT && p.side === existingPos?.side)
    .reduce((sum, p) => sum + (Number(p.qty_open) || 0), 0);
  const hasSellPos = existingPos?.side === 'SELL' || false;
  const hasBuyPos = existingPos?.side === 'BUY' || false;

  const isExitTrade = exitMode || (activeSide === 'BUY' && hasSellPos) || (activeSide === 'SELL' && hasBuyPos);
  const multiplier = isExitTrade ? 1 : 2;

  // Fallback defaults if segSetting is completely missing
  const fallbackCommType = 'Per Crore';
  let fallbackCommVal = 4500;
  const sUpper2 = (item?.segment || '').toUpperCase();
  if (sUpper2.includes('FOREX')) {
    fallbackCommVal = 2000;
  } else if (sUpper2.includes('CRYPTO')) {
    fallbackCommVal = 1000;
  }

  const rawIntradayCharge = segSetting ? computeCharge(
    segSetting.intraday_commission_type || segSetting.commission_type || 'Per Crore',
    segSetting.intraday_commission_value ?? segSetting.commission_value ?? fallbackCommVal
  ) : computeCharge(fallbackCommType, fallbackCommVal);

  const rawCarryCharge = segSetting ? computeCharge(
    segSetting.carry_commission_type || segSetting.commission_type || 'Per Crore',
    segSetting.carry_commission_value ?? segSetting.commission_value ?? fallbackCommVal
  ) : computeCharge(fallbackCommType, fallbackCommVal);

  const gttCharge = (orderType === 'GTT' && segSetting ? computeCharge(
    segSetting.gtt_commission_type || 'Per Trade',
    segSetting.gtt_commission_value ?? 10
  ) : (orderType === 'GTT' ? computeCharge('Per Trade', 15) : 0));

  // Brokerage model (matches TradeEngine):
  //   INTRADAY open: entry + exit charged upfront = rawIntradayCharge Ã— 2
  //   CARRY open:    entry + exit + carry conversion = rawIntradayCharge Ã— 2 + rawCarryCharge
  //   Exit order:    0 (already collected at open)
  //   GTT:           shows both legs breakdown

  let displayIntraday = 0;
  let displayCarry = 0;

  if (isExitTrade) {
    // Exit: show single leg exit brokerage for UI reference (already collected upfront at open)
    displayIntraday = targetPT === 'CARRY' ? 0 : rawIntradayCharge;
    displayCarry = targetPT === 'CARRY' ? rawCarryCharge : 0;
  } else if (orderType === 'GTT') {
    displayIntraday = rawIntradayCharge;
    displayCarry = rawCarryCharge;
  } else if (targetPT === 'CARRY') {
    // CARRY open: only carry conversion brokerage is shown
    displayIntraday = 0;
    displayCarry = rawCarryCharge;
  } else {
    // INTRADAY open: entry+exit both charged upfront (Ã—2)
    displayIntraday = rawIntradayCharge * 2;
    displayCarry = 0;
  }

  const calculatedBrokerage = displayIntraday + displayCarry + gttCharge;

  const intradayType = segSetting?.intraday_type ?? 'Multiplier';
  const holdingType = segSetting?.holding_type ?? 'Multiplier';
  const leverageType = productType === 'CARRY' ? holdingType : intradayType;

  const baseExposure = (orderType === 'LIMIT' || orderType === 'GTT') && limitPrice && !isNaN(parseFloat(limitPrice))
    ? (totalQty * parseFloat(limitPrice))
    : (totalQty * (priceOfScript > 0 ? priceOfScript : 0));

  let marginPortion = 0;
  if (!exitMode) {
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

  // Sync qtyInput â†’ orderQty when input is a valid number (supports decimals in lot mode)
  const handleQtyChange = (val: string) => {
    // Allow digits, a leading optional zero, and a single decimal point
    if (val !== '' && !/^\d*\.?\d*$/.test(val)) return;

    // If lotSize > 1, prevent decimals in LOT mode to avoid confusion
    if (orderUnit === 'lot' && lotSize > 1 && val.includes('.')) return;

    userHasEditedQty.current = true;
    setQtyInput(val);
    if (qtyError) setQtyError(null);
    const n = parseFloat(val);
    // Only update the committed qty when we have a real positive number
    if (!isNaN(n) && n > 0) setOrderQty(n);
  };

  const stepQty = (delta: number) => {
    if (qtyError) setQtyError(null);
    const step = orderUnit === 'lot' ? 1 : 1;
    const maxOrderLot = segSetting?.max_order_lot ?? segSetting?.max_lot ?? 0;
    const maxVal = maxOrderLot > 0
      ? (orderUnit === 'lot' ? maxOrderLot : maxOrderLot * lotSize)
      : Infinity;
    const next = Math.min(maxVal, Math.max(0.0001, parseFloat((orderQty + delta * step).toFixed(4))));
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
        const initialOrderType = (exitMode && initialOrder.order_type === 'LIMIT') ? 'TARGET' : initialOrder.order_type;
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
          setGttSubOption(exitMode ? 'TARGET' : 'LIMIT');
        }
      } else {
        setOrderQty(lotSize);
        setQtyInput(String(lotSize));
        setOrderUnit('qty');
        setOrderType('MARKET');
        setProductType(propProductType || 'INTRADAY');
        setLimitPrice('');
        setTriggerPrice('');
        setSlPrice('');
        setTpPrice('');
        setGttSubOption(exitMode ? 'TARGET' : 'LIMIT');
        userHasEditedQty.current = false;
      }
    }
  }, [item?.symbol, propProductType, exitMode, initialOrder]);

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
            p => p.symbol === item.symbol && ((p.status as string) === 'open' || (p.status as string) === 'active') && p.side === oppositeSide && p.product_type === targetPT
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
  }, [side, isOpen, item?.symbol, propProductType, exitMode, linkedPosId]);

  // Fetch balance and refresh active positions when the sheet opens
  useEffect(() => {
    if (!isOpen) return;
    refreshPositions();
  }, [isOpen, refreshPositions]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };



  const topLimit = segSetting?.top_limit ?? 0;
  const minLimit = segSetting?.min_limit ?? 0;
  
  let maxAllowedPrice = topLimit > 0 ? currentLtp * (1 + topLimit / 100) : Infinity;
  let minAllowedPrice = minLimit > 0 ? currentLtp * (1 - minLimit / 100) : 0;

  if (orderType === 'LIMIT' || orderType === 'TARGET' || (orderType === 'GTT' && !exitMode)) {
    if (side === 'BUY') {
      maxAllowedPrice = Math.min(maxAllowedPrice, currentLtp);
    } else if (side === 'SELL') {
      minAllowedPrice = Math.max(minAllowedPrice, currentLtp);
    }
  }

  // For SLM: the stop loss must be on the correct side of current market price
  // BUY SLM entry â†’ stop loss below market (protect a new long)
  // SELL SLM entry â†’ stop loss above market (protect a new short)
  if (orderType === 'SLM' && !exitMode) {
    if (side === 'BUY') {
      maxAllowedPrice = Math.min(maxAllowedPrice, currentLtp);
    } else if (side === 'SELL') {
      minAllowedPrice = Math.max(minAllowedPrice, currentLtp);
    }
  }

  // Exit mode specific logic for Stop Loss (SL)
  // Exiting a long (SELL SL): stop loss must be placed BELOW market
  // Exiting a short (BUY SL): stop loss must be placed ABOVE market
  if ((orderType === 'SL' || orderType === 'SLM') && exitMode) {
    if (side === 'BUY') {
      minAllowedPrice = Math.max(minAllowedPrice, currentLtp);
    } else if (side === 'SELL') {
      maxAllowedPrice = Math.min(maxAllowedPrice, currentLtp);
    }
  }

  const priceRangeHelp = currentLtp > 0 ? (
    <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary, #6B7280)', marginTop: '6px', fontWeight: 600 }}>
      Allowed price: {minAllowedPrice > 0 ? `${currencySymbol}${minAllowedPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `${currencySymbol}0.00`} to {maxAllowedPrice !== Infinity ? `${currencySymbol}${maxAllowedPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'No Limit'}
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
    try {
      if (!item) return;

      const parsedInputQty = parseFloat(qtyInput);
      if (isNaN(parsedInputQty) || parsedInputQty <= 0) {
        showToast('Please enter a valid quantity.');
        return;
      }

      let rawQty = orderUnit === 'lot' ? parsedInputQty * lotSize : parsedInputQty;

      // â”€â”€ Quantity Snapping & Validation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (exitMode) {
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
          showToast(`Error: Exit qty (${rawQty}) exceeds this lot's available qty (${maxExitQty}). Please reduce the quantity.`);
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
            showToast(`The maximum you can exit in a single order is ${maxOrderLot} lots or ${maxOrderQty} qty. Please execute your position in multiple orders, or use the Exit All button available on the top right.`);
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
      let resolvedClientPrice = currentLtp;
      let resolvedTriggerPrice: number | undefined = undefined;
      let resolvedStopLoss: number | undefined = undefined;
      let resolvedTarget: number | undefined = undefined;

      if (exitMode) {
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
          resolvedOrderType = 'SLM';
          resolvedTriggerPrice = parseFloat(triggerPrice) || undefined;
          resolvedClientPrice = currentLtp;
        } else if (orderType === 'GTT') {
          resolvedOrderType = 'GTT';
          resolvedStopLoss = parseFloat(slPrice) || undefined;
          resolvedTarget = parseFloat(tpPrice) || undefined;
          resolvedClientPrice = currentLtp;
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
        } else if (orderType === 'SLM') {
          resolvedOrderType = 'SLM';
          resolvedTriggerPrice = parseFloat(triggerPrice) || undefined;
          resolvedClientPrice = currentLtp;
        } else if (orderType === 'GTT') {
          resolvedOrderType = 'GTT';
          resolvedClientPrice = parseFloat(limitPrice) || currentLtp;
          resolvedTriggerPrice = parseFloat(limitPrice) || undefined;
          resolvedStopLoss = parseFloat(slPrice) || undefined;
          resolvedTarget = parseFloat(tpPrice) || undefined;
        } else {
          // MARKET
          resolvedOrderType = 'MARKET';
          resolvedClientPrice = currentLtp;
        }
      }

      // Validate Limit price constraints relative to LTP
      if (resolvedOrderType === 'LIMIT' || (resolvedOrderType === 'GTT' && !exitMode)) {
        if (placeSide === 'BUY' && resolvedClientPrice >= currentLtp) {
          window.dispatchEvent(new CustomEvent('order_error', { detail: 'Buy at limit price must be below the current market price.' }));
          return;
        }
        if (placeSide === 'SELL' && resolvedClientPrice <= currentLtp) {
          window.dispatchEvent(new CustomEvent('order_error', { detail: 'Sell at limit price must be above the current market price.' }));
          return;
        }
      }

      const isExitOrder = exitMode || (placeSide === 'BUY' && hasSellPos) || (placeSide === 'SELL' && hasBuyPos);

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
        const trigPrice = resolvedTriggerPrice;
        if (trigPrice !== undefined && !isNaN(trigPrice)) {
          if (isExitOrder) {
            // Exit stop loss order:
            // - Exiting LONG (SELL order): stop loss must be below current market price
            // - Exiting SHORT (BUY order): stop loss must be above current market price
            if (placeSide === 'BUY' && trigPrice <= currentLtp) {
              showToast('Stop loss trigger price must be above the current market price for short exits.');
              return;
            }
            if (placeSide === 'SELL' && trigPrice >= currentLtp) {
              showToast('Stop loss trigger price must be below the current market price for long exits.');
              return;
            }
          } else {
            // Entry stop loss order:
            // - SLM entry executes immediately and sets trigger price as stop loss of new position.
            //   Thus, BUY SLM = LONG position (SL below market), SELL SLM = SHORT position (SL above market).
            // - SL entry is a pending breakout order.
            //   Thus, BUY SL = breakout buy (above market), SELL SL = breakout sell (below market).
            if (resolvedOrderType === 'SLM') {
              if (placeSide === 'BUY' && trigPrice >= currentLtp) {
                showToast('Stop loss price must be below the current market price.');
                return;
              }
              if (placeSide === 'SELL' && trigPrice <= currentLtp) {
                showToast('Stop loss price must be above the current market price.');
                return;
              }
            } else { // SL order type
              if (placeSide === 'BUY' && trigPrice <= currentLtp) {
                showToast('Trigger price must be above the current market price for stop limit buy.');
                return;
              }
              if (placeSide === 'SELL' && trigPrice >= currentLtp) {
                showToast('Trigger price must be below the current market price for stop limit sell.');
                return;
              }
            }
          }
        }
      }

      // Resolve reference entry price and position side (Long vs Short)
      const refEntry = (exitMode && existingPos) ? Number(existingPos.avg_price) : resolvedClientPrice;
      const isLong = (exitMode && existingPos) ? (existingPos.side === 'BUY') : (placeSide === 'BUY');

      if (exitMode) {
        if (isLong) {
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget) && resolvedTarget <= currentLtp) {
            showToast('Target price must be above the current market price.');
            return;
          }
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss) && resolvedStopLoss >= currentLtp) {
            showToast('Stop loss price must be below the current market price.');
            return;
          }
        } else {
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget) && resolvedTarget >= currentLtp) {
            showToast('Target price must be below the current market price.');
            return;
          }
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss) && resolvedStopLoss <= currentLtp) {
            showToast('Stop loss price must be above the current market price.');
            return;
          }
        }
      } else {
        // First time purchasing validations
        const hasLimitPrice = ['LIMIT', 'SL', 'GTT'].includes(resolvedOrderType) && resolvedClientPrice !== undefined && !isNaN(resolvedClientPrice);
        if (isLong) {
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss)) {
            const referencePrice = hasLimitPrice ? resolvedClientPrice : currentLtp;
            if (resolvedStopLoss >= referencePrice) {
              showToast(`Stop loss price must be below the ${hasLimitPrice ? 'limit' : 'market'} price.`);
              return;
            }
          }
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget)) {
            if (resolvedTarget <= currentLtp) {
              showToast('Target price must be above the current market price.');
              return;
            }
          }
        } else {
          if (resolvedStopLoss !== undefined && !isNaN(resolvedStopLoss)) {
            const referencePrice = hasLimitPrice ? resolvedClientPrice : currentLtp;
            if (resolvedStopLoss <= referencePrice) {
              showToast(`Stop loss price must be above the ${hasLimitPrice ? 'limit' : 'market'} price.`);
              return;
            }
          }
          if (resolvedTarget !== undefined && !isNaN(resolvedTarget)) {
            if (resolvedTarget >= currentLtp) {
              showToast('Target price must be below the current market price.');
              return;
            }
          }
        }
      }

      if (resolvedOrderType === 'LIMIT') {
        if (placeSide === 'BUY') {
          if (resolvedClientPrice >= currentLtp) {
            showToast('Limit price must be lower than the current market price.');
            return;
          }
        } else {
          if (resolvedClientPrice <= currentLtp) {
            showToast('Limit price must be higher than the current market price.');
            return;
          }
        }
      }

      if (['LIMIT', 'SL', 'GTT'].includes(resolvedOrderType)) {
        const parsedPrice = resolvedClientPrice;
        if (placeSide === 'BUY') {
          if (pTopLimit > 0) {
            const maxAllowed = currentLtp * (1 + pTopLimit / 100);
            if (parsedPrice > maxAllowed) {
              showToast(`Maximum price allowed is ${currencySymbol}${maxAllowed.toFixed(2)}`);
              return;
            }
          }
          if (pMinLimit > 0) {
            const minAllowed = currentLtp * (1 - pMinLimit / 100);
            if (parsedPrice < minAllowed) {
              showToast(`Minimum price allowed is ${currencySymbol}${minAllowed.toFixed(2)}`);
              return;
            }
          }
        } else { // SELL side
          if (pTopLimit > 0) {
            const maxAllowed = currentLtp * (1 + pTopLimit / 100);
            if (parsedPrice > maxAllowed) {
              showToast(`Maximum price allowed is ${currencySymbol}${maxAllowed.toFixed(2)}`);
              return;
            }
          }
          if (pMinLimit > 0) {
            const minAllowed = currentLtp * (1 - pMinLimit / 100);
            if (parsedPrice < minAllowed) {
              showToast(`Minimum price allowed is ${currencySymbol}${minAllowed.toFixed(2)}`);
              return;
            }
          }
        }
      }

      if (isModify && modifyingOrderId && (modifyingOrderId.startsWith('pos-sl-') || modifyingOrderId.startsWith('pos-target-') || modifyingOrderId.startsWith('pos-gtt-'))) {
        const positionId = modifyingOrderId.replace('pos-sl-', '').replace('pos-target-', '').replace('pos-gtt-', '');
        const isSl = modifyingOrderId.startsWith('pos-sl-');
        const isTarget = modifyingOrderId.startsWith('pos-target-');
        const isGtt = modifyingOrderId.startsWith('pos-gtt-');

        const isStillTarget = isTarget && (orderType === 'TARGET' || orderType === 'LIMIT');
        const isStillSl = isSl && (orderType === 'SL' || orderType === 'SLM');
        const isStillGtt = isGtt && orderType === 'GTT';

        if (isStillTarget || isStillSl || isStillGtt) {
          const updateData = isSl
            ? { stop_loss: resolvedTriggerPrice || resolvedStopLoss || null }
            : isTarget
              ? { target: resolvedClientPrice || resolvedTarget || null }
              : { stop_loss: resolvedStopLoss || null, target: resolvedTarget || null };

          try {
            await api.patch<unknown>(`/api/positions/${positionId}`, updateData);

            showToast('Stop loss/target updated successfully');
            onSuccess?.();
            onClose();
            return;
          } catch (err) {
            if (err instanceof ApiError) {
              showToast((err.details as any)?.error || 'Failed to update position stop loss/target.');
            } else {
              showToast('Failed to update position stop loss/target.');
            }
            return;
          }
        } else {
          // User changed the order type (e.g. from Target to Market or SL)
          // Clear the old target or stop loss first so it doesn't linger
          try {
            let clearData: any = {};
            if (isSl) clearData = { stop_loss: null };
            else if (isTarget) clearData = { target: null };
            else if (isGtt) clearData = { stop_loss: null, target: null };

            await api.patch<unknown>(`/api/positions/${positionId}`, clearData);
          } catch (e) {
            console.error('[DEBUG TradeSheet handlePlace] Error clearing old target/SL:', e);
          }
          // Do not return; let execution continue to place the new order type
        }
      }
      if (exitMode && (orderType === 'SL' || orderType === 'TARGET' || orderType === 'GTT')) {
        console.log('[DEBUG TradeSheet handlePlace] exitMode setting SL/target. existingPos:', existingPos?.id, 'orderType:', orderType);
        if (!existingPos) {
          showToast('No active position found to set exit criteria.');
          return;
        }
        const updateData: { stop_loss?: number | null; target?: number | null } = {};
        if (orderType === 'SL') {
          updateData.stop_loss = resolvedTriggerPrice || resolvedStopLoss || null;
        } else if (orderType === 'TARGET') {
          updateData.target = resolvedClientPrice || resolvedTarget || null;
        } else if (orderType === 'GTT') {
          updateData.stop_loss = resolvedStopLoss || null;
          updateData.target = resolvedTarget || null;
        }

        console.log('[DEBUG TradeSheet handlePlace] Sending PATCH payload:', updateData, 'to /api/positions/', existingPos.id);

        try {
          await api.patch<unknown>(`/api/positions/${existingPos.id}`, updateData);

          console.log('[DEBUG TradeSheet handlePlace] PATCH successful');
          showToast('Stop loss/target updated successfully');
          onSuccess?.();
          handleCloseAnimation();
          return;
        } catch (err) {
          console.error('[DEBUG TradeSheet handlePlace] PATCH exception:', err);
          if (err instanceof ApiError) {
            showToast((err.details as any)?.error || 'Failed to update position stop loss/target.');
          } else {
            showToast('Failed to update position stop loss/target.');
          }
          return;
        }
      }

      if (exitMode) {
        // Exit mode: show the full-screen overlay and await the order
        window.dispatchEvent(new Event('exit-overlay-start'));

        try {
          const activeQuoteObj = (isCrypto && bSymbol ? cryptoQuote : null) || (computedKiteSymbol ? marketQuotes[computedKiteSymbol] : null) || (item?.symbol ? marketQuotes[item.symbol] : null);
          const diagnosticFields = {
            frontend_bid: activeQuoteObj?.bid,
            frontend_ask: activeQuoteObj?.ask,
            frontend_ltp: activeQuoteObj?.lastPrice ?? (activeQuoteObj as any)?.last_price ?? currentLtp,
            frontend_quote_time: activeQuoteObj?.time || (activeQuoteObj as any)?.timestamp || Date.now(),
            client_click_time: Date.now(),
          };

          const orderAttemptId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const res = await placeOrder({
            symbol: item.symbol,
            kite_instrument: computedKiteSymbol || item.symbol,
            segment: item.segment,
            side: placeSide,
            qty: finalQty,
            lots: finalLots,
            order_type: resolvedOrderType as any,
            product_type: ((linkedPosId ? activePositions.find(p => p.id === linkedPosId)?.product_type : undefined) || existingPos?.product_type || targetPT || 'INTRADAY') as 'INTRADAY' | 'CARRY',
            client_price: resolvedClientPrice,
            trigger_price: resolvedTriggerPrice,
            stop_loss: resolvedStopLoss,
            target: resolvedTarget,
            is_exit: true,
            linked_position_id: linkedPosId || undefined,
            orderAttemptId,
            ...diagnosticFields,
          });
          window.dispatchEvent(new Event('order_placed'));
          window.dispatchEvent(new Event('position-closed'));
          if (res.success) {
            showToast(`${placeSide} order sent for ${item.symbol}`);
            if (onSuccess) {
              try {
                onSuccess();
              } catch (e) {
                console.error('onSuccess refresh failed', e);
              }
            }
            handleCloseAnimation();
            setTimeout(() => {
              window.dispatchEvent(new Event('order_placed'));
              window.dispatchEvent(new Event('position-closed'));
            }, 1500);
          } else {
            const errMsg = res.error || 'Order failed. Please try again.';
            setOrderErrorMsg(errMsg);
            setOrderState('error');
            window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
            window.dispatchEvent(new Event('order_failed'));
          }
        } catch (err: any) {
          const errMsg = err.message || 'Order failed. Please try again.';
          setOrderErrorMsg(errMsg);
          setOrderState('error');
          window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
          window.dispatchEvent(new Event('order_failed'));
        } finally {
          window.dispatchEvent(new Event('exit-overlay-end'));
        }
      } else {
        // Buy/Sell flow: show the global loader overlay.
        handedOffToOrderFlow = true;
        window.dispatchEvent(new CustomEvent('global-loader-start', { detail: 'Processing Order...' }));
        
        // Modify flow: cancel the original order first, then re-place with new params
        if (isModify && modifyingOrderId && !modifyingOrderId.startsWith('pos-')) {
          try {
            await api.patch<unknown>(`/api/orders/${modifyingOrderId}`, { status: 'CANCELLED' });
          } catch (err) {
            window.dispatchEvent(new CustomEvent('toast_msg', { detail: 'Failed to cancel original order for modify.' }));
            window.dispatchEvent(new Event('global-loader-end'));
            return;
          }
        }

        try {
          const activeQuoteObj = (isCrypto && bSymbol ? cryptoQuote : null) || (computedKiteSymbol ? marketQuotes[computedKiteSymbol] : null) || (item?.symbol ? marketQuotes[item.symbol] : null);
          const diagnosticFields = {
            frontend_bid: activeQuoteObj?.bid,
            frontend_ask: activeQuoteObj?.ask,
            frontend_ltp: activeQuoteObj?.lastPrice ?? (activeQuoteObj as any)?.last_price ?? currentLtp,
            frontend_quote_time: activeQuoteObj?.time || (activeQuoteObj as any)?.timestamp || Date.now(),
            client_click_time: Date.now(),
          };

          const orderAttemptId = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;

          const res = await placeOrder({
            symbol: item.symbol,
            kite_instrument: computedKiteSymbol || item.symbol,
            segment: item.segment,
            side: placeSide,
            qty: finalQty,
            lots: finalLots,
            order_type: resolvedOrderType as any,
            product_type: productType,
            client_price: resolvedClientPrice,
            trigger_price: resolvedTriggerPrice,
            stop_loss: resolvedStopLoss,
            target: resolvedTarget,
            is_exit: (placeSide === 'BUY' && hasSellPos) || (placeSide === 'SELL' && hasBuyPos),
            linked_position_id: linkedPosId || undefined,
            orderAttemptId,
            ...diagnosticFields,
          });

          if (res.success) {
            const optimisticPayload = {
              symbol: item.symbol,
              kite_instrument: computedKiteSymbol || item.symbol,
              segment: item.segment,
              side: placeSide,
              qty: finalQty,
              client_price: resolvedClientPrice,
              product_type: productType,
            };
            window.dispatchEvent(new Event('order_placed'));
            window.dispatchEvent(new CustomEvent('order_placed_with_data', { detail: optimisticPayload }));
            showToast(`${placeSide} order sent for ${item.symbol}`);
            if (onSuccess) {
              try {
                onSuccess();
              } catch (e) {
                console.error('onSuccess refresh failed', e);
              }
            }
            handleCloseAnimation();
          } else {
            const errMsg = res.error || 'Order failed. Please try again.';
            setOrderErrorMsg(errMsg);
            setOrderState('error');
            window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
            window.dispatchEvent(new Event('order_failed'));
          }
        } catch (err: any) {
          const errMsg = err.message || 'Order failed. Please try again.';
          setOrderErrorMsg(errMsg);
          setOrderState('error');
          window.dispatchEvent(new CustomEvent('order_error', { detail: errMsg }));
          window.dispatchEvent(new Event('order_failed'));
        } finally {
          window.dispatchEvent(new Event('global-loader-end'));
        }
      }
    } catch (e) {
      console.error('[TradeSheet handlePlace] Unexpected exception:', e);
    } finally {
      // Always release the execution lock â€” exactly once, whether success or failure.
      isExecutingRef.current = false;
      // Error display is now owned by the central ClientShell modal, so always
      // reset to idle here â€” the lock is released and the sheet can accept new taps.
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
          transition: transform 0.38s cubic-bezier(0.25, 0.9, 0.35, 1.05);
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

        .ts2-scroll { flex: 1; overflow-y: auto; padding-bottom: 90px; }
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
          position: absolute; bottom: 0; left: 0; right: 0;
          max-width: 500px; margin: 0 auto; z-index: 10001;
          background: var(--card-bg, #fff); padding: 12px 14px 24px;
          display: flex; flex-direction: column; gap: 8px;
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
          background: #1F2937; color: #fff; padding: 10px 20px; border-radius: 30px;
          font-size: 0.82rem; font-weight: 600; z-index: 10002;
          opacity: 0; transition: opacity 0.3s, transform 0.3s; pointer-events: none;
          white-space: nowrap;
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

      <div id="tradeSheet" className={`ts2-sheet${(isOpen && !isClosing) ? ' open' : ''}${exitMode ? ' ts2-exit-mode' : ''} ts2-sheet--${(activeSide === 'SELL' || exitMode) ? 'sell' : 'buy'}`}>
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
                  <div className="ts2-instr-name">{item.name}</div>
                  <div className="ts2-price-value" style={{ flexShrink: 0, marginLeft: '12px' }}>{fmt(currentLtp)}</div>
                </div>
                {/* Row 2: Badge + Change% */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '3px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {exitMode && (
                      <span className="ts2-status-badge neg">Exit Position</span>
                    )}
                    {!exitMode && isFromPositions && (
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
                  {currentLtp > 0 ? fmt(bidPrice) : '--'}
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
                            const formattedLots = parseFloat(newLots.toFixed(2));
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
                      <div className="ts2-ic-val">{orderUnit === 'lot' ? orderQty : (orderQty / lotSize)}</div>
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
                          let snapped = n;
                          if (lotSize > 1) {
                            if (orderUnit === 'qty') {
                              // Keep the exact custom quantity entered by the user
                              snapped = Math.max(0.0001, n);
                            } else {
                              // Snap to nearest integer lot
                              snapped = Math.max(1, Math.round(n));
                            }
                          }
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
                    {(exitMode ? ['MARKET', 'LIMIT', 'SL', 'GTT'] : ['MARKET', 'LIMIT', 'SLM', 'GTT']).map(t => (
                      <button
                        key={t}
                        className={`ts2-pill${orderType === t ? ' active' : ''}`}
                        onClick={() => {
                          setOrderType(t);
                          if (t === 'GTT') {
                            setGttSubOption(exitMode ? 'TARGET' : 'LIMIT');
                          }
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>

                {/* LIMIT / TARGET â€” Price input (separate card, matches watchlist) */}
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

                {/* SL / SLM â€” Price input */}
                {(orderType === 'SL' || orderType === 'SLM') && (
                  <div className="ts2-card">
                    <div className="ts2-label">
                      {orderType === 'SLM'
                        ? <>Stop Loss <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol}) order executes at market price</span></>
                        : <>Stop Loss Price <span style={{ color: '#9CA3AF', textTransform: 'none', fontWeight: 500 }}>({currencySymbol})</span></>
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

                {/* GTT â€” Stop Loss / Target / Limit sub-options */}
                {orderType === 'GTT' && (
                  <div className="ts2-card">
                    {exitMode ? (
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
                                {activeSide === 'BUY'
                                  ? `Below ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `Above ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
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
                                {activeSide === 'BUY'
                                  ? `Above ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `Below ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
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
                            {currentLtp > 0 && (
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary, #6B7280)', marginTop: 4, fontWeight: 600 }}>
                                {activeSide === 'BUY'
                                  ? `Below ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `Above ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
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
                                {activeSide === 'BUY'
                                  ? `Above ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                                  : `Below ${currencySymbol}${currentLtp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                              </div>
                            )}
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
                {!exitMode && (
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
                    <span className="ts2-mv" style={{ color: (activeSide === 'SELL' || exitMode) ? '#C62E2E' : '#15803D', fontWeight: 800 }}>
                      {currencySymbol} {calculatedBrokerage.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  {showCharges && (
                    <>
                      <div className="ts2-margin-row" style={{ paddingTop: '8px' }}>
                        <span className="ts2-ml">
                          Intraday Carry
                        </span>
                        <span className="ts2-mv" style={displayIntraday > 0 ? {} : { opacity: 0.4 }}>
                          {currencySymbol} {(displayIntraday > 0 ? rawIntradayCharge : 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="ts2-margin-row">
                        <span className="ts2-ml">Carry Charges</span>
                        <span className="ts2-mv" style={displayCarry > 0 ? { color: (activeSide === 'SELL' || exitMode) ? '#C62E2E' : '#15803D', fontWeight: 700 } : { opacity: 0.4 }}>
                          {currencySymbol} {displayCarry.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="ts2-margin-row">
                        <span className="ts2-ml">GTT Charges</span>
                        <span className="ts2-mv" style={orderType === 'GTT' ? { color: (activeSide === 'SELL' || exitMode) ? '#C62E2E' : '#15803D', fontWeight: 700 } : { opacity: 0.4 }}>
                          {currencySymbol} {(orderType === 'GTT' ? gttCharge : 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
                  Indices cannot be traded directly.<br/>
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
                        {isModify ? 'MODIFY' : exitMode ? 'EXIT POSITION' : hideLotText ? 'SELL' : `SELL ${actionText}${sellPriceLabel}`}
                      </button>
                    )}
                    {(side === 'BUY' || side === 'BOTH') && (
                      <button
                        className={`ts2-btn${exitMode ? ' ts2-btn-sell' : ' ts2-btn-buy'}`}
                        disabled={isBusy || isExpired}
                        style={(isBusy || isExpired) ? { opacity: 0.5, cursor: 'not-allowed' } : {}}
                        onClick={() => handlePlace('BUY')}
                      >
                        {isModify ? 'MODIFY' : exitMode ? 'EXIT POSITION' : hideLotText ? 'BUY' : `BUY ${actionText}${buyPriceLabel}`}
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </div>

      <div className={`ts2-toast${toast ? ' show' : ''}`}>{toast}</div>
    </>
  );
};

