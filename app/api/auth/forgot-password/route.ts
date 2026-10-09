import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';
import { sendEmail, sendOtpSms } from '@/lib/twilio';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const { identifier } = body as { identifier?: string; email?: string };
    const rawInput = (identifier || body.email || '').trim();

    if (!rawInput) {
      return NextResponse.json(
        { error: 'Please enter your email address or mobile number.' },
        { status: 400 }
      );
    }

    const admin = getAdminClient();
    const digitsOnly = rawInput.replace(/\D/g, '');

    let profile: any = null;

    // 1. If input contains @, lookup directly by email
    if (rawInput.includes('@')) {
      const { data } = await admin
        .from('profiles')
        .select('id, email, phone, client_id, full_name')
        .ilike('email', rawInput.toLowerCase())
        .maybeSingle();
      profile = data;
    } else if (digitsOnly.length >= 10) {
      // 2. If 10+ digits, lookup by mobile number (last 10 digits) or client ID
      const last10 = digitsOnly.slice(-10);
      const { data } = await admin
        .from('profiles')
        .select('id, email, phone, client_id, full_name')
        .or(`phone.ilike.*${last10}*,client_id.ilike.${rawInput}`)
        .order('created_at', { ascending: false });

      if (data && data.length > 0) {
        profile = data.find(
          (p) =>
            (p.phone || '').replace(/\D/g, '').endsWith(last10) ||
            (p.client_id || '').toUpperCase() === rawInput.toUpperCase()
        ) || null;
      }
    } else {
      // 3. Shorter identifier (client_id / username)
      const { data } = await admin
        .from('profiles')
        .select('id, email, phone, client_id, full_name')
        .ilike('client_id', rawInput)
        .maybeSingle();
      profile = data;
    }

    let resolvedEmail = profile?.email ? profile.email.toLowerCase() : (rawInput.includes('@') ? rawInput.toLowerCase() : null);
    let resolvedPhone = profile?.phone || (digitsOnly.length >= 10 ? digitsOnly : null);

    if (!resolvedEmail) {
      return NextResponse.json(
        { error: 'No account found with this email address or mobile number. Please check the spelling or sign up.' },
        { status: 404 }
      );
    }

    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    let origin = host ? `${proto}://${host}` : process.env.NEXT_PUBLIC_APP_URL || 'https://www.rupeefxtrading.com';
    if (origin.endsWith('/')) origin = origin.slice(0, -1);

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: resolvedEmail,
      options: {
        redirectTo: `${origin}/reset-password`,
      },
    });

    if (linkError) {
      console.warn('[forgot-password] Supabase generateLink warning:', linkError.message);
      const isNotFound =
        (linkError as any).code === 'user_not_found' ||
        (linkError as any).status === 404 ||
        linkError.message?.toLowerCase().includes('not found');

      if (isNotFound) {
        return NextResponse.json(
          { error: 'No account found with this email address or mobile number. Please check the spelling or sign up.' },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: 'Unable to process reset request. Please try again later.' },
        { status: 500 }
      );
    }

    const otpCode = linkData?.properties?.email_otp;
    const appName = process.env.NEXT_PUBLIC_APP_NAME || 'RupeeFX Trading';

    if (!otpCode) {
      return NextResponse.json(
        { error: 'Failed to generate reset OTP. Please try again.' },
        { status: 500 }
      );
    }

    const userName = profile?.full_name || linkData?.user?.user_metadata?.full_name || 'Trader';

    // 1. Dispatch Email
    const emailSubject = `Your ${appName} Password Reset Code`;
    const emailHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 32px 24px; background: #0f172a; color: #f8fafc; border-radius: 16px; border: 1px solid #1e293b;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #38bdf8; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${appName}</h1>
          <p style="color: #94a3b8; font-size: 14px; margin-top: 4px;">Password Reset Code</p>
        </div>
        <div style="background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
          <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #e2e8f0;">
            Hello ${userName},
          </p>
          <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #cbd5e1;">
            We received a request to reset the password for your account. Use the OTP code below to set your new password:
          </p>
          <div style="background-color: #0f172a; border: 1px solid #334155; border-radius: 10px; padding: 18px; text-align: center; margin: 20px 0;">
            <p style="margin: 0 0 6px 0; font-size: 11px; color: #94a3b8; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">Your OTP Code</p>
            <span style="font-size: 32px; font-weight: 800; letter-spacing: 6px; color: #38bdf8; font-family: monospace;">${otpCode}</span>
          </div>
        </div>
        <p style="font-size: 12px; color: #64748b; text-align: center; margin: 0;">
          If you did not request a password reset, you can safely ignore this email. This code will expire in 24 hours.
        </p>
      </div>
    `;
    const emailText = `Hello ${userName},\n\nYour ${appName} password reset code is: ${otpCode}\n\nUse this code to reset your password. If you did not request this, you can ignore this email.`;

    const emailResult = await sendEmail(resolvedEmail, emailSubject, emailHtml, emailText);

    // 2. Dispatch SMS
    let smsSent = false;
    if (resolvedPhone) {
      try {
        const smsBody = `Your ${appName} password reset OTP is: ${otpCode}. It expires in 24 hours.`;
        const smsRes = await sendOtpSms(resolvedPhone, otpCode, smsBody);
        if (smsRes.success) smsSent = true;
      } catch (smsErr) {
        console.warn('[forgot-password] SMS delivery warning:', smsErr);
      }
    }

    const maskEmail = (em: string) => {
      const [user, domain] = em.split('@');
      if (!user || !domain) return em;
      const visible = user.slice(0, 2);
      return `${visible}***@${domain}`;
    };

    const maskPhone = (ph: string) => {
      const clean = ph.replace(/\D/g, '');
      if (clean.length < 4) return ph;
      const last4 = clean.slice(-4);
      return `+91 ******${last4}`;
    };

    return NextResponse.json({
      success: true,
      resolvedEmail,
      maskedEmail: maskEmail(resolvedEmail),
      maskedPhone: resolvedPhone ? maskPhone(resolvedPhone) : null,
      emailSent: emailResult.success,
      smsSent,
    });
  } catch (err: any) {
    console.error('[forgot-password] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
