/**
 * PATCH /api/admin/actlogs/:id
 *
 * Atomically updates an act_logs row and optionally creates a reconciliation
 * row in pay_requests when the price changes.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 3.7
 */

import { requireAdmin } from '../../_auth';

// ---------------------------------------------------------------------------
// PATCH handler
// ---------------------------------------------------------------------------

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> | { id: string } },
) {
  try {
    // Step 1: Authenticate and authorise the caller
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Resolve route param
    const resolvedParams = await Promise.resolve(params);
    const id = resolvedParams.id;
    if (!id) {
      return Response.json({ error: 'Missing ID' }, { status: 400 });
    }

    // Step 3: Parse request body
    const body = await request.json();
    const { symbol, qty, price, edit_remark } = body as {
      symbol?: string;
      qty?: number;
      price?: number;
      edit_remark?: string;
    };

    // Step 4: Validate edit_remark — required and non-empty
    // Validates: Requirement 6.1, 2.3
    if (!edit_remark || edit_remark.trim() === '') {
      return Response.json({ error: 'edit_remark is required' }, { status: 400 });
    }

    // Step 5: Fetch current row to read original_price
    // Validates: Requirement 6.3 (needed for diff calculation in RPC)
    const { data: currentRow, error: fetchError } = await adminClient
      .from('act_logs')
      .select('original_price')
      .eq('id', id)
      .single();

    if (fetchError || !currentRow) {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }

    const originalPrice: number | null = currentRow.original_price ?? null;

    // Step 6: Call the edit_act_log RPC — performs atomic update + optional reconciliation
    // Validates: Requirements 6.2, 6.3, 6.4
    const { data: rpcResult, error: rpcError } = await adminClient.rpc('edit_act_log', {
      p_id: id,
      p_admin_id: callerUser.id,
      p_symbol: symbol ?? null,
      p_qty: qty ?? null,
      p_price: price ?? null,
      p_edit_remark: edit_remark.trim(),
      p_original_price: originalPrice,
    });

    // Any RPC call-level error is a 500
    if (rpcError) {
      console.error('[PATCH actlogs] RPC error:', rpcError);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Step 7: Inspect the RPC response code and map to HTTP status
    const result = rpcResult as { code: number; reconciliation_id?: string; error?: string } | null;

    if (!result) {
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Map RPC codes to HTTP responses
    // Validates: Requirement 6.4 → 500, 6.5 → 200, 6.6 → 200 with reconciliation_id
    if (result.code === 404) {
      return Response.json({ error: result.error ?? 'Not found' }, { status: 404 });
    }

    if (result.code === 422) {
      return Response.json({ error: result.error ?? 'Unprocessable entity' }, { status: 422 });
    }

    if (result.code === 500) {
      return Response.json({ error: result.error ?? 'Internal server error' }, { status: 500 });
    }

    if (result.code === 200) {
      if (result.reconciliation_id) {
        // Validates: Requirement 6.6
        return Response.json(
          {
            message: 'Log updated and reconciliation row created',
            reconciliation_id: result.reconciliation_id,
          },
          { status: 200 },
        );
      }
      // Validates: Requirement 6.5
      return Response.json({ message: 'Log updated successfully' }, { status: 200 });
    }

    // Unexpected RPC response — treat as internal error
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  } catch (err: any) {
    console.error('[PATCH actlogs] Unexpected error:', err);
    return Response.json({ error: err.message || 'Internal error' }, { status: 500 });
  }
}
