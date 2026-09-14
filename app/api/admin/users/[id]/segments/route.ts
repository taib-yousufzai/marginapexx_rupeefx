/**
 * GET  /api/admin/users/[id]/segments
 * POST /api/admin/users/[id]/segments
 *
 * GET  returns all segment_settings rows for the given user id.
 * POST upserts an array of segment settings using onConflict: 'user_id,segment,side'.
 *
 * Validates: Requirements 8.1–8.4, 12.1–12.6
 */

import { requireAdmin } from '../../../_auth';
import { getRole } from '../../../../../../lib/auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SegmentSettingRow = {
  id: string;
  user_id: string;
  segment: string;
  side: 'BUY' | 'SELL';
  commission_type: string;
  commission_value: number;
  carry_commission_type: string;
  carry_commission_value: number;
  gtt_commission_type: string;
  gtt_commission_value: number;
  profit_hold_sec: number;
  loss_hold_sec: number;
  strike_range: number;
  max_lot: number;
  max_order_lot: number;
  intraday_leverage: number;
  intraday_type: string;
  holding_leverage: number;
  entry_buffer: number;
  holding_type: string;
  bid_buffer: number;
  exit_buffer: number;
  trade_allowed: boolean;
  top_limit: number;
  min_limit: number;
  exit_price_mode?: 'BID_ASK' | 'LTP';
  created_at: string;
  updated_at: string;
};

// Fields accepted in the POST body for each segment setting entry
type SegmentSettingInput = Omit<SegmentSettingRow, 'id' | 'created_at' | 'updated_at'>;

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 12.1–12.6
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve params
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Scope broker access to their own child users
    const callerRole = getRole(callerUser);
    if (callerRole === 'broker') {
      const { data: targetProfile, error: targetError } = await adminClient
        .from('profiles')
        .select('parent_id')
        .eq('id', id)
        .single();
      if (targetError || !targetProfile || targetProfile.parent_id !== callerUser.id) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') ?? 'normal';
    const table = mode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';

    // Step 3: Query all segment_settings rows for this user
    // Validates: Requirements 8.1, 8.3
    const { data, error } = await adminClient
      .from(table)
      .select(
        'id, user_id, segment, side, commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value, profit_hold_sec, loss_hold_sec, strike_range, max_lot, max_order_lot, intraday_leverage, intraday_type, holding_leverage, entry_buffer, holding_type, bid_buffer, exit_buffer, trade_allowed, top_limit, min_limit, exit_price_mode, created_at, updated_at',
      )
      .eq('user_id', id);

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 4: Return the segment settings array
    return Response.json(data ?? [], { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize the caller
    // Validates: Requirements 12.1–12.6
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve params
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;

    // Scope broker updates to their own child users
    const callerRole = getRole(callerUser);
    if (callerRole === 'broker') {
      const { data: targetProfile, error: targetError } = await adminClient
        .from('profiles')
        .select('parent_id')
        .eq('id', id)
        .single();
      if (targetError || !targetProfile || targetProfile.parent_id !== callerUser.id) {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Step 3: Parse JSON body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    // Step 4: Validate that body is a non-empty array
    // Validates: Requirement 8.4
    if (!Array.isArray(body) || body.length === 0) {
      return Response.json(
        { error: 'Request body must be a non-empty array of segment settings' },
        { status: 400 },
      );
    }

    // Step 5: Validate each entry has required fields (segment and side)
    for (const entry of body) {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as Record<string, unknown>).segment !== 'string' ||
        !['BUY', 'SELL'].includes((entry as Record<string, unknown>).side as string)
      ) {
        return Response.json(
          { error: 'Each entry must have a valid segment (string) and side (BUY|SELL)' },
          { status: 400 },
        );
      }
    }

    // Step 6: Build upsert payload — force user_id to the path param
    // Validates: Requirement 8.4
    const rows: SegmentSettingInput[] = (body as Record<string, unknown>[]).map((entry) => ({
      user_id: id,
      segment: entry.segment as string,
      side: entry.side as 'BUY' | 'SELL',
      commission_type:
        typeof entry.commission_type === 'string' ? entry.commission_type : 'Per Crore',
      commission_value:
        typeof entry.commission_value === 'number' ? entry.commission_value : 4500,
      carry_commission_type:
        typeof entry.carry_commission_type === 'string' ? entry.carry_commission_type : 'Per Crore',
      carry_commission_value:
        typeof entry.carry_commission_value === 'number' ? entry.carry_commission_value : 4500,
      gtt_commission_type:
        typeof entry.gtt_commission_type === 'string' ? entry.gtt_commission_type : 'Per Trade',
      gtt_commission_value:
        typeof entry.gtt_commission_value === 'number' ? entry.gtt_commission_value : 10,
      profit_hold_sec:
        typeof entry.profit_hold_sec === 'number' ? entry.profit_hold_sec : 120,
      loss_hold_sec:
        typeof entry.loss_hold_sec === 'number' ? entry.loss_hold_sec : 0,
      strike_range:
        typeof entry.strike_range === 'number' ? entry.strike_range : 0,
      max_lot:
        typeof entry.max_lot === 'number' ? entry.max_lot : 50,
      max_order_lot:
        typeof entry.max_order_lot === 'number' ? entry.max_order_lot : 50,
      intraday_leverage:
        typeof entry.intraday_leverage === 'number' ? entry.intraday_leverage : 50,
      intraday_type:
        typeof entry.intraday_type === 'string' ? entry.intraday_type : 'Multiplier',
      holding_leverage:
        typeof entry.holding_leverage === 'number' ? entry.holding_leverage : 5,
      entry_buffer:
        typeof entry.entry_buffer === 'number' && !isNaN(entry.entry_buffer) ? entry.entry_buffer : 0.3,
      holding_type:
        typeof entry.holding_type === 'string' ? entry.holding_type : 'Multiplier',
      bid_buffer:
        typeof entry.bid_buffer === 'number' && !isNaN(entry.bid_buffer) ? entry.bid_buffer : 0.3,
      exit_buffer:
        typeof entry.exit_buffer === 'number' && !isNaN(entry.exit_buffer) ? entry.exit_buffer : 0.17,
      trade_allowed:
        typeof entry.trade_allowed === 'boolean' ? entry.trade_allowed : true,
      top_limit:
        typeof entry.top_limit === 'number' ? entry.top_limit : 0,
      min_limit:
        typeof entry.min_limit === 'number' ? entry.min_limit : 0,
      use_custom_calc:
        typeof entry.use_custom_calc === 'boolean' ? entry.use_custom_calc : false,
      exit_price_mode:
        entry.exit_price_mode === 'LTP' ? 'LTP' : 'BID_ASK',
    }));

    const url = new URL(request.url);
    const mode = url.searchParams.get('mode') ?? 'normal';
    const table = mode === 'scalper' ? 'scalper_segment_settings' : 'segment_settings';

    // Step 7: Upsert the segment settings array
    // Validates: Requirements 8.2, 8.4
    const { data, error } = await adminClient
      .from(table)
      .upsert(rows, { onConflict: 'user_id,segment,side' })
      .select();

    if (error) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    try {
      const { ConfigurationService } = await import('@/lib/trading/ConfigurationService');
      ConfigurationService.clearCache();
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      await redis.publish('config:invalidate', 'clear');
    } catch (cacheErr) {
      console.error('[segments] Failed to clear and publish ConfigurationService invalidation:', cacheErr);
    }

    try {
      const { checkAndSquareOffPositionsForMargin } = await import('@/lib/marginSquareOff');
      await checkAndSquareOffPositionsForMargin(id, adminClient);
    } catch (err) {
      console.error('[segments] Error triggering margin check:', err);
    }

    // Step 8: Return the upserted rows
    return Response.json(data ?? [], { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
