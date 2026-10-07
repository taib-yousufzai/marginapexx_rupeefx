import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';
import { sendEmail } from '@/lib/twilio';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const { email } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email address is required' }, { status: 400 });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return NextResponse.json({ error: 'Please enter a valid email address' }, { status: 400 });
    }

    const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
    const proto = req.headers.get('x-forwarded-proto') || 'https';
    const origin = req.headers.get('origin') || (host ? `${proto}://${host}` : process.env.NEXT_PUBLIC_APP_URL || 'https://www.rupeefxtrading.com');

    const admin = getAdminClient();
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: normalizedEmail,
      options: {
        redirectTo: `${origin}/reset-password`,
      },
    });

    if (error) {
      console.warn('[forgot-password] generateLink error for', normalizedEmail, error.message);
      // Return success to avoid email enumeration
      return NextResponse.json({ success: true });
    }

    if (data?.properties?.action_link) {
      const resetLink = data.properties.action_link;
      const appName = process.env.NEXT_PUBLIC_APP_NAME || 'RupeeFX Trading';

      const emailSubject = `Reset your ${appName} password`;
      const emailHtml = `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #0f172a; color: #f8fafc; border-radius: 16px; border: 1px solid #1e293b;">
          <div style="text-align: center; margin-bottom: 28px;">
            <h1 style="color: #38bdf8; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${appName}</h1>
            <p style="color: #94a3b8; font-size: 14px; margin-top: 4px;">Password Reset Request</p>
          </div>
          <div style="background: #1e293b; border-radius: 12px; padding: 24px; margin-bottom: 24px;">
            <p style="margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: #e2e8f0;">
              Hello,
            </p>
            <p style="margin: 0 0 20px; font-size: 14px; line-height: 1.5; color: #cbd5e1;">
              We received a request to reset the password for your account associated with <strong style="color: #ffffff;">${normalizedEmail}</strong>. Click the button below to set a new password:
            </p>
            <div style="text-align: center; margin: 28px 0;">
              <a href="${resetLink}" style="background: linear-gradient(135deg, #0284c7, #2563eb); color: #ffffff; text-decoration: none; padding: 14px 28px; border-radius: 10px; font-weight: 700; font-size: 15px; display: inline-block; box-shadow: 0 4px 12px rgba(37, 99, 235, 0.3);">
                Reset Password
              </a>
            </div>
            <p style="margin: 0; font-size: 12px; color: #94a3b8; line-height: 1.5;">
              Or copy and paste this link into your browser:<br/>
              <a href="${resetLink}" style="color: #38bdf8; word-break: break-all; font-size: 12px;">${resetLink}</a>
            </p>
          </div>
          <p style="font-size: 12px; color: #64748b; text-align: center; margin: 0;">
            If you did not request a password reset, you can safely ignore this email. Your password will remain unchanged.
          </p>
        </div>
      `;
      const emailText = `Hello,\n\nWe received a request to reset the password for your account. Please click the link below or copy and paste it into your browser to reset your password:\n\n${resetLink}\n\nIf you did not request this, you can ignore this email.`;

      const emailResult = await sendEmail(normalizedEmail, emailSubject, emailHtml, emailText);
      if (!emailResult.success) {
        console.error('[forgot-password] Email delivery error:', emailResult.error);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[forgot-password] Unexpected error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
