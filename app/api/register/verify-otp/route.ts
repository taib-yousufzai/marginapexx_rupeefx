import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import { getAdminClient } from '@/lib/adminClient';
import { logAction, extractClientIp } from '@/lib/actionLogger';

function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { email, otp, password } = body as {
      email: string;
      otp: string;
      password: string;
    };

    if (!email || !otp || !password) {
      return Response.json(
        { error: 'email, otp, and password are required' },
        { status: 400 },
      );
    }

    if (password.length < 8) {
      return Response.json(
        { error: 'Password must be at least 8 characters.' },
        { status: 400 },
      );
    }

    const emailLower = email.trim().toLowerCase();
    const admin = getAdminClient();

    // ── Clean up stale expired OTPs ───────────────────────────────────────────
    await admin.rpc('cleanup_expired_otps').then(() => null); // fire-and-forget, ignore errors

    // ── Fetch the stored OTP record ───────────────────────────────────────────
    const { data: record, error: fetchError } = await admin
      .from('otp_verifications')
      .select('otp_hash, expires_at, full_name, phone, broker_ref')
      .eq('email', emailLower)
      .single();

    if (fetchError || !record) {
      return Response.json(
        { error: 'No pending verification found. Please request a new code.' },
        { status: 400 },
      );
    }

    // ── Check expiry ──────────────────────────────────────────────────────────
    if (new Date(record.expires_at) < new Date()) {
      await admin.from('otp_verifications').delete().eq('email', emailLower);
      return Response.json(
        { error: 'Code has expired. Please request a new one.' },
        { status: 400 },
      );
    }

    // ── Verify OTP hash ───────────────────────────────────────────────────────
    if (hashOtp(otp.trim()) !== record.otp_hash) {
      return Response.json(
        { error: 'Invalid code. Please try again.' },
        { status: 400 },
      );
    }

    // ── OTP valid → create the auth user (email pre-confirmed) ───────────────
    // email_confirm: true  →  bypasses Supabase confirmation email entirely.
    // broker_ref in user_metadata is picked up by the handle_new_user DB trigger.
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email: emailLower,
      password,
      email_confirm: true,
      user_metadata: {
        full_name: record.full_name,
        phone: record.phone ?? null,
        broker_ref: record.broker_ref ?? null,
        role: 'user',
      },
    });

    if (authError) {
      console.error('[verify-otp] Auth createUser error:', authError);
      // Surface friendly message for duplicate-email race condition
      if (authError.message?.toLowerCase().includes('already')) {
        return Response.json(
          { error: 'An account with this email already exists. Please sign in.' },
          { status: 409 },
        );
      }
      return Response.json({ error: authError.message }, { status: 400 });
    }

    const userId = authData.user.id;

    // ── Upsert profile (explicit — also done by the DB trigger, but we are
    //    authoritative here for broker parent_id mapping) ──────────────────────
    // Default segments granted to every new user.
    // Admins can restrict specific segments later via the UpdateSegments admin panel.
    const DEFAULT_SEGMENTS = [
      'INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT',
      'NSE-EQ', 'MCX-FUT', 'MCX-OPT', 'CRYPTO', 'FOREX', 'COMEX', 'US-EQ',
    ];

    // Generate a unique 6-character uppercase alphanumeric client_id
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let client_id = '';
    let isUnique = false;
    let attempts = 0;
    while (!isUnique && attempts < 10) {
      client_id = '';
      for (let i = 0; i < 6; i++) {
        client_id += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const { data: existing } = await admin.from('profiles').select('id').eq('client_id', client_id).single();
      if (!existing) {
        isUnique = true;
      }
      attempts++;
    }
    
    if (!isUnique) {
      console.error('[verify-otp] Failed to generate unique client_id after 10 attempts');
      // Roll back auth user so the registration can be retried cleanly
      await admin.auth.admin.deleteUser(userId);
      return Response.json(
        { error: 'Failed to create user profile due to ID collision. Please try again.' },
        { status: 500 },
      );
    }

    const { error: profileError } = await admin.from('profiles').upsert(
      {
        id: userId,
        email: emailLower,
        full_name: record.full_name,
        phone: record.phone ?? null,
        role: 'user',
        parent_id: record.broker_ref ?? null,
        active: true,
        segments: DEFAULT_SEGMENTS,
        client_id,
      },
      { onConflict: 'id' },
    );

    if (profileError) {
      console.error('[verify-otp] Profile upsert error:', profileError);
      // Roll back auth user so the registration can be retried cleanly
      await admin.auth.admin.deleteUser(userId);
      return Response.json(
        { error: 'Failed to create user profile. Please try again.' },
        { status: 500 },
      );
    }

    // ── Delete the consumed OTP ───────────────────────────────────────────────
    await admin.from('otp_verifications').delete().eq('email', emailLower);

    console.info('[verify-otp] Account created:', userId, '| parent_id:', record.broker_ref);
    
    logAction({
      actionType: 'REGISTER_USER',
      module: 'AUTH',
      apiEndpoint: '/api/register/verify-otp',
      httpMethod: 'POST',
      ipAddress: extractClientIp(req.headers),
      userId: userId,
      username: emailLower,
      role: 'user',
      requestPayload: { email: emailLower },
      responseStatus: 200,
      isSuccess: true,
      metadata: { broker_ref: record.broker_ref, client_id }
    });

    return Response.json({ success: true, userId });
  } catch (err: any) {
    console.error('[verify-otp] Unexpected error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
