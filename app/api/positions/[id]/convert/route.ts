import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { calculateCarryBrokerage } from '@/lib/trading/BrokerageCalculator';
import { getLotSizeFromDB } from '@/lib/lotSize';
import { calculateFreeMarginFromPositions } from '@/lib/floatingPnl';
import { RiskValidation } from '@/lib/trading/RiskValidation';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const user = await getUserFromRequest(request);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: positionId } = await params;
  if (!positionId) {
    return NextResponse.json({ error: 'Missing position id' }, { status: 400 });
  }

  try {
    const body = await request.json();
    const { product_type } = body;
    if (!product_type || !['INTRADAY', 'CARRY'].includes(product_type)) {
      return NextResponse.json({ error: 'Invalid or missing product type' }, { status: 400 });
    }

    const admin = getAdminClient();

    // 1. Fetch position and profile
    const [{ data: pos, error: posErr }, { data: profile, error: profileErr }] = await Promise.all([
      admin.from('positions')
        .select('*')
        .eq('id', positionId)
        .eq('user_id', user.id)
        .single(),
      admin.from('profiles')
        .select('parent_id, balance, trading_mode')
        .eq('id', user.id)
        .single()
    ]);

    if (posErr || !pos) {
      return NextResponse.json({ error: 'Position not found' }, { status: 404 });
    }
    if (profileErr || !profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    if (pos.product_type === product_type) {
      return NextResponse.json({ error: `Position is already ${product_type}` }, { status: 400 });
    }

    // Market closed check for all conversions
    const segmentId = RiskValidation.resolveTradingHoursSegmentId(pos.symbol || '', pos.settlement || '');


    if (segmentId !== 'crypto') {
      const { data: marketHours } = await admin
        .from('trading_hours')
        .select('start_time, end_time, is_active')
        .eq('id', segmentId)
        .maybeSingle();

      const isMarketOpen = RiskValidation.validateTradingHours(marketHours);
      if (!isMarketOpen) {
        return NextResponse.json({ error: `Market is closed. You cannot convert position to ${product_type}.` }, { status: 400 });
      }
    }

    // 2. Calculate the new leverage and required margin
    const isScalper = profile.trading_mode === 'scalper';
    const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';

    const lookupId = profile.parent_id ?? user.id;
    const { data: segSetting } = await admin.from(targetTable)
      .select('holding_leverage, intraday_leverage, holding_type, intraday_type, commission_type, commission_value, carry_commission_type, carry_commission_value')
      .eq('user_id', lookupId)
      .eq('segment', pos.settlement || '')
      .eq('side', pos.side)
      .maybeSingle();

    let finalLeverage: number | null = segSetting 
      ? (product_type === 'CARRY' ? Number(segSetting.holding_leverage) : Number(segSetting.intraday_leverage))
      : null;

    if (!finalLeverage || finalLeverage <= 0) {
      const settlement = (pos.settlement || '').toUpperCase();
      if (settlement.includes('FOREX') || settlement.includes('CDS')) {
        finalLeverage = product_type === 'CARRY' ? 10 : 100;
      } else if (settlement.includes('CRYPTO')) {
        finalLeverage = product_type === 'CARRY' ? 1 : 10;
      } else {
        finalLeverage = product_type === 'CARRY' ? 5 : 50;
      }
    }

    let leverageType: string = segSetting 
      ? (product_type === 'CARRY' ? (segSetting.holding_type || 'Multiplier') : (segSetting.intraday_type || 'Multiplier'))
      : 'Multiplier';

    let newMarginRequired = 0;
    const exposure = Number(pos.qty_open) * Number(pos.entry_price);
    
    if (leverageType === '%') {
      newMarginRequired = exposure * (finalLeverage / 100);
    } else if (leverageType === 'Fixed') {
      // Fetch lot size dynamically from DB, falling back to hardcoded values
      const admin = getAdminClient();
      const symbolLotSize = await getLotSizeFromDB(pos.symbol || '', admin);
      const lotsUsed = Number(pos.qty_open) / symbolLotSize;
      newMarginRequired = lotsUsed * finalLeverage;
    } else {
      newMarginRequired = exposure / finalLeverage;
    }
    const currentPositionMargin = Number(pos.margin_required || 0);
    const marginDifference = newMarginRequired - currentPositionMargin;

    // 3. Fetch free margin once (needed for both margin diff check and brokerage check)
    const { data: allOpenPos } = await admin.from('positions')
      .select('locked_margin, margin_required, pnl')
      .eq('user_id', user.id)
      .eq('status', 'open');

    const balance = Number(profile.balance || 0);
    const freeMargin = calculateFreeMarginFromPositions(balance, allOpenPos || []);

    // If converting requires more margin, check availability
    if (marginDifference > 0 && freeMargin < marginDifference) {
      return NextResponse.json({
        error: `Insufficient margin. Available free margin: ₹${freeMargin.toFixed(2)}, Required additional margin: ₹${marginDifference.toFixed(2)}`
      }, { status: 400 });
    }

    // 3.5 Calculate carry brokerage if converting to CARRY and not yet paid
    let carryBrokerageToCharge = 0;
    if (product_type === 'CARRY' && !pos.carry_brokerage_paid) {
      const adminClient = getAdminClient();
      const lotSize = await getLotSizeFromDB(pos.symbol || '', adminClient);
      const calculatedLots = Number(pos.qty_open) / lotSize;

      carryBrokerageToCharge = calculateCarryBrokerage({
        productType: 'CARRY',
        qty: Number(pos.qty_open),
        entryPrice: Number(pos.entry_price),
        lots: Number(pos.lots || 0) || calculatedLots || undefined,
        carryCommissionType: segSetting?.carry_commission_type,
        commissionType: segSetting?.commission_type,
        carryCommissionValue: segSetting?.carry_commission_value != null ? Number(segSetting.carry_commission_value) : null,
        commissionValue: segSetting?.commission_value != null ? Number(segSetting.commission_value) : null,
      });

      if (carryBrokerageToCharge > 0 && freeMargin < (marginDifference + carryBrokerageToCharge)) {
        return NextResponse.json({
          error: `Insufficient margin. Free margin: ₹${freeMargin.toFixed(2)}, Required: ₹${(marginDifference + carryBrokerageToCharge).toFixed(2)} (including ₹${carryBrokerageToCharge.toFixed(2)} carry brokerage)`
        }, { status: 400 });
      }
    }

    // Call the atomic database transaction RPC
    const idempotencyKey = `CONV_BRK_${positionId}`;
    const { data: success, error: rpcErr } = await admin.rpc('convert_position_v1', {
      p_position_id: positionId,
      p_user_id: user.id,
      p_new_product_type: product_type,
      p_new_margin: newMarginRequired,
      p_carry_brokerage: carryBrokerageToCharge,
      p_idempotency_key: idempotencyKey
    });

    if (rpcErr || !success) {
      console.error('[Positions Convert API] RPC Error:', rpcErr);
      return NextResponse.json({ error: rpcErr?.message || 'Failed to convert position' }, { status: 500 });
    }

    try {
      const { isRailwayDbConfigured, getRailwayPool } = await import('@/lib/railway-db');
      if (isRailwayDbConfigured()) {
        const db = getRailwayPool();
        if (db) {
          await db.query(
            `UPDATE public.positions 
             SET product_type = $1, 
                 margin_required = $2, 
                 carry_brokerage_paid = CASE WHEN $3::numeric > 0 THEN true ELSE carry_brokerage_paid END,
                 updated_at = now() 
             WHERE id = $4::uuid AND user_id = $5::uuid;`,
            [product_type, newMarginRequired, carryBrokerageToCharge, positionId, user.id]
          );
          if (carryBrokerageToCharge > 0) {
            await db.query(
              `UPDATE public.profiles SET balance = balance - $1::numeric WHERE id = $2::uuid;`,
              [carryBrokerageToCharge, user.id]
            );
          }
        }
      }
    } catch (rErr) {
      console.warn('[Positions Convert API] Railway sync warning:', rErr);
    }

    try {
      const { invalidateUserPositionsCache } = await import('@/lib/redisSettingsCache');
      await invalidateUserPositionsCache(user.id);
    } catch (_) {}

    return NextResponse.json({ success: true, product_type }, { status: 200 });
  } catch (err: any) {
    console.error('[Positions Convert API] Error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
