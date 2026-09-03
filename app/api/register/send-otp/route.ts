/**
 * POST /api/register/send-otp
 * Generates a 6-digit OTP, stores it hashed, and sends it via Gmail SMTP (nodemailer).
 *
 * Required env vars:
 *   GMAIL_USER         — your Gmail address (e.g. yourapp@gmail.com)
 *   GMAIL_APP_PASSWORD — Gmail App Password (NOT your regular password)
 *                        Generate at: https://myaccount.google.com/apppasswords
 *                        (2-Step Verification must be enabled first)
 */
import { NextRequest } from 'next/server';
import { createHash, randomInt } from 'crypto';
import { getAdminClient } from '@/lib/adminClient';
import { sendEmail, sendOtpSms } from '@/lib/twilio';

const OTP_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;

function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

// Transporter logic moved to central communication service in lib/twilio.ts

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, fullName, phone, brokerRef } = body as {
      email: string;
      fullName: string;
      phone?: string;
      brokerRef?: string;
    };

    if (!email || !fullName) {
      return Response.json(
        { error: 'email and fullName are required' },
        { status: 400 },
      );
    }

    const emailLower = email.trim().toLowerCase();
    const phoneClean = phone?.trim() || '';
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || 'unknown';

    // ── 0. Optional Cloudflare Turnstile Bot Verification ──────────────────────
    const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
    if (turnstileSecret) {
      const turnstileToken = (body as any).turnstileToken;
      if (!turnstileToken) {
        return Response.json({ error: 'Captcha verification required. Please refresh and try again.' }, { status: 400 });
      }
      try {
        const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            secret: turnstileSecret,
            response: turnstileToken,
            remoteip: ip,
          }),
        });
        const verifyData = await verifyRes.json();
        if (!verifyData.success) {
          return Response.json({ error: 'Captcha verification failed. Please try again.' }, { status: 400 });
        }
      } catch (err) {
        console.error('[send-otp] Turnstile verification error:', err);
      }
    }

    const admin = getAdminClient();

    // ── 1. IP-based rate-limit (Max 3 OTP requests per IP per 10 minutes) ─────
    if (ip !== 'unknown') {
      const { getRedisClient } = await import('@/lib/redis');
      const redis = getRedisClient();
      const ipKey = `rate_limit:send_otp:ip:${ip}`;
      const count = await redis.incr(ipKey);
      if (count === 1) {
        await redis.expire(ipKey, 600); // 10 minutes TTL
      }
      if (count > 3) {
        return Response.json(
          { error: 'Too many registration requests from this IP. Please try again in 10 minutes.' },
          { status: 429 },
        );
      }
    }

    // ── 2. Rate-limit by Email (60s cooldown) ──────────────────────────────────
    const { data: existingEmail } = await admin
      .from('otp_verifications')
      .select('created_at, expires_at')
      .eq('email', emailLower)
      .maybeSingle();

    if (existingEmail) {
      // If the existing OTP has expired, skip cooldown — treat as fresh registration
      const isExpired = existingEmail.expires_at && new Date(existingEmail.expires_at).getTime() < Date.now();
      if (!isExpired) {
        const secondsSinceLast =
          (Date.now() - new Date(existingEmail.created_at).getTime()) / 1000;
        if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
          const waitSeconds = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast);
          return Response.json(
            { error: `Please wait ${waitSeconds}s before requesting another code.` },
            { status: 429 },
          );
        }
      }
    }

    // ── 3. Rate-limit by Phone Number (60s cooldown) ───────────────────────────
    if (phoneClean) {
      const { data: existingPhone } = await admin
        .from('otp_verifications')
        .select('created_at')
        .eq('phone', phoneClean)
        .maybeSingle();

      if (existingPhone) {
        const secondsSinceLast =
          (Date.now() - new Date(existingPhone.created_at).getTime()) / 1000;
        if (secondsSinceLast < RESEND_COOLDOWN_SECONDS) {
          const waitSeconds = Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLast);
          return Response.json(
            { error: `Please wait ${waitSeconds}s before requesting another code.` },
            { status: 429 },
          );
        }
      }
    }

    // ── Resolve brokerRef (supports admin/broker referral_code, client_id, or UUID) ──
    let resolvedBrokerRef = brokerRef?.trim() || null;
    if (resolvedBrokerRef) {
      if (resolvedBrokerRef.length === 36) {
        const { data: refProfile } = await admin
          .from('profiles')
          .select('id')
          .eq('id', resolvedBrokerRef)
          .maybeSingle();
        resolvedBrokerRef = refProfile ? refProfile.id : null;
      } else {
        const { data: refProfile } = await admin
          .from('profiles')
          .select('id')
          .or(`client_id.ilike.${resolvedBrokerRef},referral_code.ilike.${resolvedBrokerRef}`)
          .maybeSingle();
        resolvedBrokerRef = refProfile ? refProfile.id : null;
      }
    }

    // ── Generate OTP ──────────────────────────────────────────────────────────
    const otp = String(randomInt(100000, 999999));
    const otpHash = hashOtp(otp);
    const expiresAt = new Date(
      Date.now() + OTP_TTL_MINUTES * 60 * 1000,
    ).toISOString();

    // ── Upsert OTP record (replaces any previous OTP for this email) ──────────
    const { error: dbError } = await admin.from('otp_verifications').upsert(
      {
        email: emailLower,
        otp_hash: otpHash,
        full_name: fullName.trim(),
        phone: phone?.trim() || null,
        broker_ref: resolvedBrokerRef,
        expires_at: expiresAt,
        created_at: new Date().toISOString(), // refresh timestamp for rate-limit
      },
      { onConflict: 'email' },
    );

    if (dbError) {
      console.error('[send-otp] DB error:', dbError);
      return Response.json({ error: 'Failed to store OTP' }, { status: 500 });
    }

    // ── Send OTP email via SendGrid (with Gmail SMTP fallback) ────────────────
    const emailSubject = 'Your MarginApex verification code';
    const emailHtml = `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="color:#1a1a2e;margin-bottom:8px">MarginApex</h2>
        <p style="color:#444;margin-bottom:24px">
          Hi ${fullName.trim()},<br/>Use the code below to verify your email.
          It expires in <strong>${OTP_TTL_MINUTES} minutes</strong>.
        </p>
        <div style="background:#f4f4f4;border-radius:12px;padding:24px;text-align:center;
                    letter-spacing:8px;font-size:2.5rem;font-weight:700;color:#0f172a">
          ${otp}
        </div>
        <p style="color:#888;font-size:0.85rem;margin-top:24px">
          If you didn't request this, you can safely ignore this email.
        </p>
      </div>
    `;
    const emailText = `Your MarginApex verification code is: ${otp}\n\nIt expires in ${OTP_TTL_MINUTES} minutes.`;

    const emailResult = await sendEmail(emailLower, emailSubject, emailHtml, emailText);
    if (!emailResult.success) {
      console.error('[send-otp] Email delivery failed:', emailResult.error);
    }

    // ── Send OTP SMS via APItxt or Twilio ─────────────────────────────────────
    let smsSent = false;
    if (phone && phone.trim()) {
      const smsBody = `Your MarginApex verification code is: ${otp}. It expires in ${OTP_TTL_MINUTES} minutes.`;
      const smsResult = await sendOtpSms(phone, otp, smsBody);
      if (smsResult.success) smsSent = true;
    }

    if (!emailResult.success && !smsSent) {
      const detail = emailResult.error ? ` (${emailResult.error})` : '';
      return Response.json(
        { error: 'Failed to send OTP. Please try again in a moment.', retryable: true },
        { status: 202 },
      );
    }

    console.info(`[send-otp] OTP sent. Email: ${emailResult.success}, SMS: ${smsSent}`);
    return Response.json({ success: true, emailSent: emailResult.success, smsSent });
  } catch (err: any) {
    console.error('[send-otp] Unexpected error:', err?.stack || err);
    return Response.json(
      { error: err?.message ? `Failed to send verification email: ${err.message}` : 'Failed to send verification email. Please try again.' },
      { status: 500 },
    );
  }
}
