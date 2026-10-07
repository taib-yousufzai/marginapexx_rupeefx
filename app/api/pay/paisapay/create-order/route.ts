import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { encryptPayload, PAISAPAY_CREATE_ORDER_URL } from '@/lib/paisapay';

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const { amount, mobile } = body;

    const numAmount = Number(amount);
    if (!numAmount || isNaN(numAmount) || numAmount < 300) {
      return NextResponse.json({ error: 'Minimum deposit is ₹300' }, { status: 400 });
    }

    const cleanMobile = String(mobile || '').replace(/\D/g, '');
    if (cleanMobile.length < 10) {
      return NextResponse.json({ error: 'Valid 10-digit mobile number required' }, { status: 400 });
    }

    const token = process.env.PAISAPAY_API_TOKEN;
    const secretKey = process.env.PAISAPAY_SECRET_KEY;

    if (!token || !secretKey) {
      return NextResponse.json({ error: 'Gateway configuration missing on server' }, { status: 500 });
    }

    const payRequestId = crypto.randomUUID();

    // Insert PENDING pay_request for the user with 1500ms safety timeout
    try {
      const adminClient = getAdminClient();
      const insertPromise = adminClient
        .from('pay_requests')
        .insert({
          id: payRequestId,
          user_id: user.id,
          type: 'DEPOSIT',
          amount: numAmount,
          upi: cleanMobile,
          status: 'PENDING',
        });
      const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 1500));
      await Promise.race([insertPromise, timeoutPromise]);
    } catch (insertErr) {
      console.warn('[PaisaPay create-order] DB insert warning (continuing with generated id):', insertErr);
    }

    // Encrypt order payload with PaisaPay AES-256-ECB
    const payload = encryptPayload(
      {
        amount: numAmount.toFixed(2),
        mobile: cleanMobile.slice(-10),
        udf1: payRequestId, // Store pay_request ID for webhook reference
      },
      secretKey
    );

    return NextResponse.json({
      success: true,
      gatewayUrl: PAISAPAY_CREATE_ORDER_URL,
      token,
      payload,
      requestId: payRequestId,
    });
  } catch (error: any) {
    console.error('[PaisaPay create-order error]:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
