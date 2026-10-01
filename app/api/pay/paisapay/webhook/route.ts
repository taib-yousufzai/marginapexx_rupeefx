import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';
import { decryptPayload, PaisaPayWebhookPayload } from '@/lib/paisapay';

export async function POST(req: NextRequest) {
  try {
    let token = '';
    let encryptedPayload = '';

    const contentType = req.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const body = await req.json();
      token = body.token || '';
      encryptedPayload = body.payload || '';
    } else {
      // Handles standard form-urlencoded and multipart/form-data
      const formData = await req.formData();
      token = (formData.get('token') as string) || '';
      encryptedPayload = (formData.get('payload') as string) || '';
    }

    const expectedToken = process.env.PAISAPAY_API_TOKEN;
    const secretKey = process.env.PAISAPAY_SECRET_KEY;

    if (!token || token !== expectedToken || !encryptedPayload || !secretKey) {
      console.warn('[PaisaPay Webhook] Authentication failed or missing payload:', {
        tokenMatch: token === expectedToken,
        hasPayload: !!encryptedPayload,
        hasSecret: !!secretKey,
      });
      return new NextResponse('Unauthorized', { status: 401 });
    }

    // 1. Decrypt callback payload
    const callbackData: PaisaPayWebhookPayload = decryptPayload(encryptedPayload, secretKey);
    console.log('[PaisaPay Webhook Data]:', callbackData);

    const { status, utr, udf1, order_id } = callbackData;
    const payRequestId = udf1;

    if (!payRequestId) {
      console.error('[PaisaPay Webhook] Missing udf1 (pay_request id)');
      return new NextResponse('success', { status: 200 });
    }

    const adminClient = getAdminClient();

    // 2. Fetch the pay_request row
    const { data: requestRow, error: fetchError } = await adminClient
      .from('pay_requests')
      .select('id, user_id, status, amount')
      .eq('id', payRequestId)
      .single();

    if (fetchError || !requestRow) {
      console.warn(`[PaisaPay Webhook] pay_request ${payRequestId} not found.`);
      return new NextResponse('success', { status: 200 });
    }

    // If already approved, return success immediately to prevent duplicate credit
    if (requestRow.status === 'APPROVED') {
      return new NextResponse('success', { status: 200 });
    }

    // 3. Process status
    if (status === 'SUCCESS') {
      // Update UTR on pay_requests row first
      if (utr || order_id) {
        await adminClient
          .from('pay_requests')
          .update({ utr: utr || order_id })
          .eq('id', payRequestId);
      }

      // Execute atomic RPC to approve and credit balance/ledger
      const { data: rpcData, error: rpcError } = await adminClient.rpc('approve_pay_request', {
        request_id: payRequestId,
        admin_id: requestRow.user_id, // System automated approval attribution
      });

      if (rpcError) {
        console.error('[PaisaPay Webhook] approve_pay_request RPC error:', rpcError);
      } else {
        console.log('[PaisaPay Webhook] Payment approved successfully for user:', requestRow.user_id, rpcData);
      }
    } else if (status === 'FAILED') {
      await adminClient
        .from('pay_requests')
        .update({
          status: 'REJECTED',
          updated_at: new Date().toISOString(),
        })
        .eq('id', payRequestId);
    }

    // PaisaPay requirement: return plain text "success" string
    return new NextResponse('success', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  } catch (error: any) {
    console.error('[PaisaPay Webhook] Critical exception:', error);
    return new NextResponse('Internal Error', { status: 500 });
  }
}
