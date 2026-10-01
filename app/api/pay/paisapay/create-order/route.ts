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
    if (!numAmount || isNaN(numAmount) || numAmount < 100) {
      return NextResponse.json({ error: 'Minimum deposit is ₹100' }, { status: 400 });
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

    const adminClient = getAdminClient();

    // Insert PENDING pay_request for the user
    const { data: insertData, error: insertError } = await adminClient
      .from('pay_requests')
      .insert({
        user_id: user.id,
        type: 'DEPOSIT',
        amount: numAmount,
        upi: cleanMobile,
        status: 'PENDING',
      })
      .select('id')
      .single();

    if (insertError || !insertData) {
      console.error('[PaisaPay create-order] DB insert error:', insertError);
      return NextResponse.json({ error: 'Failed to create payment record' }, { status: 500 });
    }

    // Encrypt order payload with PaisaPay AES-256-ECB
    const payload = encryptPayload(
      {
        amount: numAmount.toFixed(2),
        mobile: cleanMobile.slice(-10),
        udf1: insertData.id, // Store pay_request ID for webhook reference
      },
      secretKey
    );

    return NextResponse.json({
      success: true,
      gatewayUrl: PAISAPAY_CREATE_ORDER_URL,
      token,
      payload,
      requestId: insertData.id,
    });
  } catch (error: any) {
    console.error('[PaisaPay create-order error]:', error);
    return NextResponse.json({ error: error.message || 'Internal server error' }, { status: 500 });
  }
}
