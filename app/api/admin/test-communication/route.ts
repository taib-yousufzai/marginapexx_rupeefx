import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { sendEmail, sendSms } from '@/lib/twilio';

export async function POST(request: NextRequest) {
  try {
    // 1. Verify user is authenticated and is an admin/super_admin
    const user = await getUserFromRequest(request);
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = getAdminClient();
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (profileErr || !profile) {
      return NextResponse.json({ error: 'User profile not found' }, { status: 404 });
    }

    const userRole = profile.role;
    if (userRole !== 'super_admin' && userRole !== 'admin') {
      return NextResponse.json({ error: 'Forbidden: Admins only' }, { status: 403 });
    }

    // 2. Parse request body
    const body = await request.json();
    const { type, email, phone, message, subject } = body as {
      type: 'email' | 'sms' | 'both';
      email?: string;
      phone?: string;
      message?: string;
      subject?: string;
    };

    if (!type) {
      return NextResponse.json({ error: 'Missing type field' }, { status: 400 });
    }

    const results: Record<string, any> = {};

    // 3. Send email if requested
    if (type === 'email' || type === 'both') {
      if (!email) {
        return NextResponse.json({ error: 'Missing email address' }, { status: 400 });
      }
      const emailSubject = subject || 'Test Notification from MarginApex';
      const emailMessage = message || 'This is a test notification from MarginApex verifying SendGrid/Gmail SMTP integration.';
      const emailHtml = `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="color:#1a1a2e;margin-bottom:8px">MarginApex Test</h2>
          <p style="color:#444;margin-bottom:24px">${emailMessage}</p>
        </div>
      `;
      const emailRes = await sendEmail(email, emailSubject, emailHtml, emailMessage);
      results.email = emailRes;
    }

    // 4. Send SMS if requested
    if (type === 'sms' || type === 'both') {
      if (!phone) {
        return NextResponse.json({ error: 'Missing phone number' }, { status: 400 });
      }
      const smsMessage = message || 'This is a test SMS from MarginApex verifying Twilio SMS integration.';
      const smsRes = await sendSms(phone, smsMessage);
      results.sms = smsRes;
    }

    return NextResponse.json({ success: true, results });
  } catch (err: any) {
    console.error('[POST /api/admin/test-communication] unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error', details: err.message || String(err) }, { status: 500 });
  }
}
