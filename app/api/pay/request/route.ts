/**
 * POST /api/pay/request  — Submit a new deposit or withdrawal request.
 * PATCH /api/pay/request — Edit a PENDING request: cancels the old one
 *                          (CANCELLED_BY_USER) and inserts a fresh PENDING row.
 */

import { createClient } from '@supabase/supabase-js';
import { validatePayRequest, WalletRules } from '../../../../lib/payValidation';
import { logAction, extractClientIp } from '@/lib/actionLogger';

function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('Missing env: NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceKey) throw new Error('Missing env: SUPABASE_SERVICE_ROLE_KEY');
  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// POST — original submit handler (unchanged)
// ---------------------------------------------------------------------------

import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';

export async function POST(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const adminClient = getAdminClient();

    const { data: rulesData, error: rulesError } = await adminClient
      .from('wallet_rules').select('*').eq('id', 1).single();
    if (rulesError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    const rules: WalletRules = {
      withdraw_enabled: rulesData.withdraw_enabled,
      allowed_days: rulesData.allowed_days,
      start_time: rulesData.start_time,
      end_time: rulesData.end_time,
      min_withdraw: Number(rulesData.min_withdraw),
      min_deposit: Number(rulesData.min_deposit),
    };

    let body: any;
    try { body = await request.clone().json(); } catch {
      return Response.json({ error: 'Invalid type' }, { status: 400 });
    }

    const validation = validatePayRequest(body, rules, new Date());
    if (!validation.valid) {
      return Response.json({ error: validation.error }, { status: validation.status });
    }
    const { data: validatedData } = validation;

    const { data: insertData, error: insertError } = await adminClient
      .from('pay_requests')
      .insert({
        user_id: user.id,
        type: validatedData.type,
        amount: validatedData.amount,
        account_name: validatedData.account_name ?? null,
        account_no: validatedData.account_no ?? null,
        ifsc: validatedData.ifsc ?? null,
        upi: validatedData.upi ?? null,
        utr: validatedData.utr ?? null,
        screenshot_url: validatedData.screenshot_url ?? null,
        status: 'PENDING',
      })
      .select('id').single();

    if (insertError) {
      if (insertError.code === '23505') {
        return Response.json({ error: 'This UTR has already been submitted.' }, { status: 400 });
      }
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    logAction({
      actionType: validatedData.type === 'DEPOSIT' ? 'SUBMIT_DEPOSIT' : 'SUBMIT_WITHDRAWAL',
      module: 'WALLET',
      apiEndpoint: '/api/pay/request',
      httpMethod: 'POST',
      ipAddress: extractClientIp(request.headers),
      userId: user.id,
      username: user.user_metadata?.username || user.email,
      role: user.user_metadata?.role,
      requestPayload: body,
      responseStatus: 201,
      isSuccess: true,
      metadata: { request_id: insertData.id, amount: validatedData.amount }
    });

    return Response.json({ id: insertData.id }, { status: 201 });
  } catch (error: any) {
    console.error('[POST pay request]', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// PATCH — edit a PENDING request
//
// Flow:
//  1. Verify the request belongs to the authenticated user and is PENDING.
//  2. Mark it CANCELLED_BY_USER.
//  3. Insert a new PENDING row with the updated fields.
//  4. Return the new request id.
// ---------------------------------------------------------------------------

export async function PATCH(request: Request): Promise<Response> {
  try {
    const user = await getUserFromRequest(request);
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const adminClient = getAdminClient();

    let body: Record<string, any>;
    try { body = await request.clone().json(); } catch {
      return Response.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { id: oldId, ...fields } = body;
    if (!oldId || typeof oldId !== 'string') {
      return Response.json({ error: 'Missing request id' }, { status: 400 });
    }

    // Step 1 — fetch and verify ownership + PENDING status
    const { data: existing, error: fetchErr } = await adminClient
      .from('pay_requests')
      .select('id, user_id, status, type')
      .eq('id', oldId)
      .single();

    if (fetchErr || !existing) {
      return Response.json({ error: 'Request not found' }, { status: 404 });
    }
    if (existing.user_id !== user.id) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (existing.status !== 'PENDING') {
      return Response.json({ error: 'Only pending requests can be edited' }, { status: 409 });
    }

    // Step 2 — cancel the old request (enforce PENDING status to avoid race conditions with admin)
    const { error: cancelErr, data: canceledData } = await adminClient
      .from('pay_requests')
      .update({ status: 'CANCELLED_BY_USER', updated_at: new Date().toISOString() })
      .eq('id', oldId)
      .eq('status', 'PENDING')
      .select('id');

    if (cancelErr) {
      console.error('[PATCH /api/pay/request] cancel error:', cancelErr.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
    
    if (!canceledData || canceledData.length === 0) {
      return Response.json({ error: 'Request was already processed or cancelled' }, { status: 409 });
    }



    // Step 3 — validate new fields using wallet_rules
    const { data: rulesData, error: rulesError } = await adminClient
      .from('wallet_rules').select('*').eq('id', 1).single();
    if (rulesError) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    const rules: WalletRules = {
      withdraw_enabled: rulesData.withdraw_enabled,
      allowed_days: rulesData.allowed_days,
      start_time: rulesData.start_time,
      end_time: rulesData.end_time,
      min_withdraw: Number(rulesData.min_withdraw),
      min_deposit: Number(rulesData.min_deposit),
    };

    // Preserve the original type — user cannot change deposit→withdrawal or vice versa
    const payload = { type: existing.type, ...fields };
    const validation = validatePayRequest(payload, rules, new Date());
    if (!validation.valid) {
      // Roll back cancellation so the user isn't left with nothing
      const { error: rollbackErr } = await adminClient
        .from('pay_requests')
        .update({ status: 'PENDING', updated_at: new Date().toISOString() })
        .eq('id', oldId);
      if (rollbackErr) {
        console.error('[PATCH /api/pay/request] rollback failed during validation:', rollbackErr);
      }
      return Response.json({ error: validation.error }, { status: validation.status });
    }
    const { data: validatedData } = validation;

    // Step 4 — insert fresh PENDING row
    const { data: newRow, error: insertErr } = await adminClient
      .from('pay_requests')
      .insert({
        user_id: user.id,
        type: validatedData.type,
        amount: validatedData.amount,
        account_name: validatedData.account_name ?? null,
        account_no: validatedData.account_no ?? null,
        ifsc: validatedData.ifsc ?? null,
        upi: validatedData.upi ?? null,
        utr: validatedData.utr ?? null,
        screenshot_url: validatedData.screenshot_url ?? null,
        status: 'PENDING',
      })
      .select('id').single();

    if (insertErr) {
      // Roll back cancellation
      const { error: rollbackErr2 } = await adminClient
        .from('pay_requests')
        .update({ status: 'PENDING', updated_at: new Date().toISOString() })
        .eq('id', oldId);
      if (rollbackErr2) {
        console.error('[PATCH /api/pay/request] rollback failed during insert error:', rollbackErr2);
      }
      if (insertErr.code === '23505') {
        return Response.json({ error: 'This UTR has already been submitted.' }, { status: 400 });
      }
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    logAction({
      actionType: validatedData.type === 'DEPOSIT' ? 'EDIT_DEPOSIT' : 'EDIT_WITHDRAWAL',
      module: 'WALLET',
      apiEndpoint: '/api/pay/request',
      httpMethod: 'PATCH',
      ipAddress: extractClientIp(request.headers),
      userId: user.id,
      username: user.user_metadata?.username || user.email,
      role: user.user_metadata?.role,
      requestPayload: body,
      responseStatus: 201,
      isSuccess: true,
      metadata: { new_id: newRow.id, old_id: oldId, amount: validatedData.amount }
    });

    return Response.json({ id: newRow.id, cancelled_id: oldId }, { status: 201 });
  } catch (error: any) {
    console.error('[PATCH pay request]', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
