/**
 * Brokerage Calculator
 *
 * Single source of truth for all commission calculations on this platform.
 *
 * Commission types supported:
 *   'Per Crore'        → (exposure × rate) / 10,000,000
 *   'Per Lot'          → lots × rate
 *   'Per Trade'/'Flat' → flat rate per trade
 *   (fallback)         → exposure × 0.001  (0.1%)
 *
 * Two public functions:
 *   calculateSingleLegCharge  — one trade leg, no doubling (used by order entry)
 *   calculateCarryBrokerage   — both legs × 2, CARRY only (used at close / conversion)
 */

// ─── Shared commission params (used by both functions) ──────────────────────

export interface CommissionParams {
  /** Notional exposure = qty × price */
  exposure: number;
  /** Number of lots for 'Per Lot' calculations */
  lots: number;
  /** 'Per Crore' | 'Per Lot' | 'Per Trade' | 'Flat' */
  commissionType: string;
  /** Numeric rate corresponding to the commission type */
  commissionValue: number;
}

/**
 * Calculate the brokerage charge for a single trade leg.
 * No doubling — caller is responsible for multiplying if both legs are needed.
 */
export function calculateSingleLegCharge({
  exposure,
  lots,
  commissionType,
  commissionValue,
}: CommissionParams): number {
  if (commissionValue <= 0) return 0;

  if (commissionType === 'Per Crore') {
    return (exposure * commissionValue) / 10_000_000;
  }
  if (commissionType === 'Per Lot') {
    return lots * commissionValue;
  }
  if (commissionType === 'Per Trade' || commissionType === 'Flat') {
    return commissionValue;
  }
  // Unknown type — fall back to 0.1%
  return exposure * 0.001;
}

// ─── Order Brokerage Aggregator (Intraday + Carry + GTT) ───────────────────

export interface CalculateOrderBrokerageParams {
  exposure: number;
  lots: number;
  productType: 'INTRADAY' | 'CARRY' | string;
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT' | string;
  isExit?: boolean;
  segSetting?: {
    commission_type?: string | null;
    commission_value?: number | null;
    intraday_commission_type?: string | null;
    intraday_commission_value?: number | null;
    carry_commission_type?: string | null;
    carry_commission_value?: number | null;
    gtt_commission_type?: string | null;
    gtt_commission_value?: number | null;
    use_custom_calc?: boolean | null;
  } | null;
  dbSegment?: string;
  fallbackCommType?: string;
  fallbackCommVal?: number;
}

export interface OrderBrokerageResult {
  intradayCharge: number;
  carryCharge: number;
  gttCharge: number;
  totalBrokerage: number;
  entryIntradayCharge: number;
  entryCarryCharge: number;
  entryGttCharge: number;
  displayBrokerage: number;
}

export function calculateOrderBrokerage({
  exposure,
  lots,
  productType,
  orderType,
  isExit = false,
  segSetting,
  dbSegment,
  fallbackCommType = 'Per Crore',
  fallbackCommVal = 4500,
}: CalculateOrderBrokerageParams): OrderBrokerageResult {
  if (isExit) {
    return {
      intradayCharge: 0,
      carryCharge: 0,
      gttCharge: 0,
      totalBrokerage: 0,
      entryIntradayCharge: 0,
      entryCarryCharge: 0,
      entryGttCharge: 0,
      displayBrokerage: 0,
    };
  }

  const isCustomCalc = segSetting?.use_custom_calc;
  if (dbSegment === 'CRYPTO' && isCustomCalc) {
    return {
      intradayCharge: 0,
      carryCharge: 0,
      gttCharge: 0,
      totalBrokerage: 0,
      entryIntradayCharge: 0,
      entryCarryCharge: 0,
      entryGttCharge: 0,
      displayBrokerage: 0,
    };
  }

  const multiplier = 2; // entry + exit legs charged upfront

  // 1. Intraday Charge (always applies to entry orders)
  const intradayCommType = segSetting?.intraday_commission_type || segSetting?.commission_type || fallbackCommType;
  const rawIntradayVal = segSetting?.intraday_commission_value ?? segSetting?.commission_value;
  const intradayCommVal = (rawIntradayVal != null && Number(rawIntradayVal) > 0) ? rawIntradayVal : fallbackCommVal;
  const singleIntraday = calculateSingleLegCharge({
    exposure,
    lots,
    commissionType: intradayCommType,
    commissionValue: Number(intradayCommVal),
  });
  const entryIntradayCharge = Math.round(singleIntraday * 100) / 100;
  const intradayCharge = Math.round(singleIntraday * multiplier * 100) / 100;

  // 2. Carry Charge (applies ONLY if CARRY product type)
  // NOTE: GTT is an order execution type, NOT a product type.
  // GTT + INTRADAY trades must NOT incur carry charges.
  let singleCarry = 0;
  let entryCarryCharge = 0;
  let carryCharge = 0;
  if (productType === 'CARRY') {
    const rawCarryVal = segSetting?.carry_commission_value;
    const isCarryExplicit = rawCarryVal != null && Number(rawCarryVal) > 0 && (Number(rawCarryVal) !== 4500 || Number(intradayCommVal) === 4500);
    const carryCommType = (isCarryExplicit && segSetting?.carry_commission_type) ? segSetting.carry_commission_type : intradayCommType;
    const carryCommVal = isCarryExplicit ? Number(rawCarryVal) : intradayCommVal;

    singleCarry = calculateSingleLegCharge({
      exposure,
      lots,
      commissionType: carryCommType,
      commissionValue: Number(carryCommVal),
    });
    entryCarryCharge = Math.round(singleCarry * 100) / 100;
    carryCharge = Math.round(singleCarry * multiplier * 100) / 100;
  }

  // 3. GTT Charge (applies if GTT order type)
  let singleGtt = 0;
  let entryGttCharge = 0;
  let gttCharge = 0;
  if (orderType === 'GTT') {
    const gttCommType = segSetting?.gtt_commission_type || 'Per Trade';
    const gttCommVal = segSetting?.gtt_commission_value ?? 10;
    singleGtt = calculateSingleLegCharge({
      exposure,
      lots,
      commissionType: gttCommType,
      commissionValue: Number(gttCommVal),
    });
    entryGttCharge = Math.round(singleGtt * 100) / 100;
    gttCharge = Math.round(singleGtt * 100) / 100;
  }

  const totalBrokerage = Math.round((intradayCharge + carryCharge + gttCharge) * 100) / 100;
  const displayBrokerage = Math.round((entryIntradayCharge + entryCarryCharge + entryGttCharge) * 100) / 100;

  return {
    intradayCharge,
    carryCharge,
    gttCharge,
    totalBrokerage,
    entryIntradayCharge,
    entryCarryCharge,
    entryGttCharge,
    displayBrokerage,
  };
}

// ─── Carry brokerage (legacy interface — backward-compatible) ────────────────

export interface CarryBrokerageParams {
  /** Position's product_type at close time */
  productType: string;
  /** Quantity being closed */
  qty: number;
  /** Entry price used for exposure calculation */
  entryPrice: number;
  /** Number of lots (falls back to qty if omitted) */
  lots?: number;
  /** carry_commission_type from segment_settings (preferred) */
  carryCommissionType?: string | null;
  /** carry_commission_value from segment_settings (preferred) */
  carryCommissionValue?: number | null;
  /** commission_type from segment_settings (fallback) */
  commissionType?: string | null;
  /** commission_value from segment_settings (fallback) */
  commissionValue?: number | null;
}

/**
 * Calculate carry brokerage for a position being closed.
 *
 * Returns 0 for non-CARRY positions.
 * Returns the total charge for both legs (entry + exit = × 2).
 */
export function calculateCarryBrokerage(params: CarryBrokerageParams): number {
  if (params.productType !== 'CARRY') return 0;

  const rawCarryVal = params.carryCommissionValue;
  const intradayVal = Number(params.commissionValue ?? 4500);
  const isCarryExplicit = rawCarryVal != null && Number(rawCarryVal) > 0 && (Number(rawCarryVal) !== 4500 || intradayVal === 4500);

  const commType = (isCarryExplicit && params.carryCommissionType) ? params.carryCommissionType : (params.commissionType || 'Per Crore');
  const commVal = isCarryExplicit ? Number(rawCarryVal) : intradayVal;

  const exposure = params.qty * params.entryPrice;
  const lots = params.lots ?? params.qty;

  const singleLeg = calculateSingleLegCharge({
    exposure,
    lots,
    commissionType: commType,
    commissionValue: commVal,
  });

  return Math.max(0, Math.round(singleLeg * 2 * 100) / 100);
}

