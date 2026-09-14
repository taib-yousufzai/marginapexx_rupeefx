/**
 * POST /api/admin/users/bulk-segments
 *
 * Bulk updates segment settings for all users under a specific broker.
 */

import { requireAdmin } from '../../_auth';

export async function POST(request: Request): Promise<Response> {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient } = authResult;

    const { broker, segments, config } = await request.json();

    if (!broker || !segments || !Array.isArray(segments) || segments.length === 0 || !config) {
      return Response.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // 1. Find all users under this broker (including sub-brokers and clients)
    const { data: profiles, error: pError } = await adminClient
      .from('profiles')
      .select('id, parent_id, segments');

    if (pError) throw pError;

    const targetUserIds: string[] = [broker];
    const findDescendants = (parentId: string) => {
      profiles.forEach(p => {
        if (p.parent_id === parentId) {
          targetUserIds.push(p.id);
          findDescendants(p.id);
        }
      });
    };
    
    findDescendants(broker);

    if (targetUserIds.length === 0) {
      return Response.json({ error: 'No users found under this broker' }, { status: 404 });
    }

    // 2. Build list of rows to upsert to ensure 100% of target users get settings applied
    const upsertRows: any[] = [];
    for (const userId of targetUserIds) {
      for (const seg of segments) {
        for (const side of ['BUY', 'SELL'] as const) {
          upsertRows.push({
            user_id: userId,
            segment: seg,
            side,
            commission_type: config.commissionType,
            commission_value: Number(config.commissionValue),
            carry_commission_type: config.carryCommissionType ?? 'Per Crore',
            carry_commission_value: Number(config.carryCommissionValue ?? 4500),
            gtt_commission_type: config.gttCommissionType ?? 'Per Trade',
            gtt_commission_value: Number(config.gttCommissionValue ?? 10),
            profit_hold_sec: Number(config.profitHoldSec),
            loss_hold_sec: Number(config.loss_hold_sec),
            strike_range: Number(config.strikeRange),
            max_lot: Number(config.maxLot),
            max_order_lot: Number(config.maxOrderLot),
            intraday_leverage: Number(config.intradayLeverage),
            intraday_type: config.intradayType,
            holding_leverage: Number(config.holdingLeverage),
            holding_type: config.holdingType,
            entry_buffer: Number(config.entryBuffer),
            bid_buffer: Number(config.bidBuffer),
            exit_buffer: Number(config.exitBuffer),
            trade_allowed: config.tradeAllowed
          });
        }
      }
    }

    // Perform bulk upsert in segment_settings table using unique key constraint
    const { error: uError } = await adminClient
      .from('segment_settings')
      .upsert(upsertRows, { onConflict: 'user_id,segment,side' });

    if (uError) throw uError;

    // 3. Sync profiles segments to ensure these segments are actually allowed/active
    const profileUpdatePromises: any[] = [];
    for (const p of profiles) {
      if (targetUserIds.includes(p.id)) {
        const existingSegments: string[] = p.segments ?? [];
        const updatedSegments = Array.from(new Set([...existingSegments, ...segments]));
        if (updatedSegments.length !== existingSegments.length) {
          profileUpdatePromises.push(
            adminClient
              .from('profiles')
              .update({ segments: updatedSegments })
              .eq('id', p.id)
          );
        }
      }
    }

    if (profileUpdatePromises.length > 0) {
      await Promise.all(profileUpdatePromises);
    }

    // Trigger margin checks in parallel for all target users
    try {
      const { checkAndSquareOffPositionsForMargin } = await import('@/lib/marginSquareOff');
      await Promise.all(targetUserIds.map(userId => checkAndSquareOffPositionsForMargin(userId, adminClient)));
    } catch (err) {
      console.error('[bulk-segments] Error running margin check:', err);
    }

    return Response.json({ 
      success: true, 
      message: `Updated ${segments.length} segments for ${targetUserIds.length} users.` 
    }, { status: 200 });

  } catch (err: any) {
    console.error('[POST /api/admin/users/bulk-segments] Error:', err);
    return Response.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
