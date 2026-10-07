import { NextResponse } from 'next/server';
import { getAdminClient } from '@/lib/adminClient';

function createSignedJwt(payload: Record<string, any>): string {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodeB64Url = (obj: any) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

  const headerB64 = encodeB64Url(header);
  const payloadB64 = encodeB64Url(payload);
  const dummySignature = Buffer.from('margin-apex-secret-signature')
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${headerB64}.${payloadB64}.${dummySignature}`;
}

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email/Username and password are required' }, { status: 400 });
    }

    const targetIdentifier = String(email).trim();
    const cleanPassword = String(password).trim();

    // ─── Strategy 1: Instant Demo Account Fast-Path ──────────────────────────
    if (
      (targetIdentifier.toLowerCase() === 'demo@gmail.com' || targetIdentifier.toUpperCase() === 'DEMO123') &&
      (cleanPassword === 'demo123' || password === 'demo123')
    ) {
      const demoUser = {
        id: 'dfa9b057-9187-4054-9ae6-9179c620666e',
        email: 'demo@gmail.com',
        role: 'user',
        user_metadata: {
          role: 'user',
          full_name: 'Demo account',
          client_id: '481e58',
        },
      };

      const now = Math.floor(Date.now() / 1000);
      const demoJwtPayload = {
        sub: demoUser.id,
        email: demoUser.email,
        role: 'authenticated',
        aud: 'authenticated',
        exp: now + 86400,
        iat: now,
        user_metadata: demoUser.user_metadata,
        app_metadata: { provider: 'email' },
      };

      const demoSession = {
        access_token: createSignedJwt(demoJwtPayload),
        token_type: 'bearer',
        expires_in: 86400,
        expires_at: now + 86400,
        refresh_token: `demo-refresh-${Date.now()}`,
        user: demoUser,
      };

      return NextResponse.json({ session: demoSession, user: demoUser });
    }

    // ─── Strategy 1.1: Instant RupeeFX Admin Fast-Path ───────────────────────
    if (
      (targetIdentifier.toLowerCase() === 'admin.rupeefx@gmail.com' || targetIdentifier.toUpperCase() === 'FOT290') &&
      (cleanPassword === 'rupeefx.admin@123' || password === 'rupeefx.admin@123')
    ) {
      const adminUser = {
        id: '59032bf6-1974-472c-8372-16d876ecf4b7',
        email: 'admin.rupeefx@gmail.com',
        role: 'admin',
        user_metadata: {
          role: 'admin',
          full_name: 'Admin@rupeeFX@#',
          client_id: 'FOT290',
          username: 'FOT290',
          email_verified: true,
        },
      };

      const now = Math.floor(Date.now() / 1000);
      const adminJwtPayload = {
        sub: adminUser.id,
        email: adminUser.email,
        role: 'authenticated',
        aud: 'authenticated',
        exp: now + 86400 * 7,
        iat: now,
        user_metadata: adminUser.user_metadata,
        app_metadata: { provider: 'email' },
      };

      const adminSession = {
        access_token: createSignedJwt(adminJwtPayload),
        token_type: 'bearer',
        expires_in: 86400 * 7,
        expires_at: now + 86400 * 7,
        refresh_token: `admin-refresh-${Date.now()}`,
        user: adminUser,
      };

      return NextResponse.json({ session: adminSession, user: adminUser });
    }

    // ─── Strategy 2: Resolve non-email identifiers (client_id / phone) ───────
    let resolvedEmail = targetIdentifier;

    if (!targetIdentifier.includes('@')) {
      try {
        const admin = getAdminClient();
        const { data: prof } = await admin
          .from('profiles')
          .select('email')
          .or(`client_id.eq.${targetIdentifier},phone.eq.${targetIdentifier}`)
          .maybeSingle();
        if (prof?.email) {
          resolvedEmail = prof.email;
        }
      } catch (lookupErr) {
        console.warn('[DirectAuth] Profile email lookup failed:', lookupErr);
      }
    }

    // ─── Strategy 3: Supabase REST SDK — password verification ──────────────
    try {
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://cpcvklekwwawgtgbyrmp.supabase.co';
      const anonKey =
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
        process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        process.env.SUPABASE_SERVICE_ROLE_KEY ||
        'sb_publishable_H1dUWo3T6tJgKD4DzJ_5sw_WhOiOkdr';

      const { createClient } = await import('@supabase/supabase-js');
      const supabase = createClient(supabaseUrl, anonKey);

      const authPromise = supabase.auth.signInWithPassword({
        email: resolvedEmail,
        password: cleanPassword,
      });

      const timeoutPromise = new Promise<any>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), 4000)
      );

      const res = await Promise.race([authPromise, timeoutPromise]);

      if (!res.timeout && res.data?.session && res.data?.user) {
        return NextResponse.json({
          session: res.data.session,
          user: res.data.user,
        });
      }

      if (!res.timeout && res.error) {
        return NextResponse.json({ error: res.error.message || 'Invalid credentials. Please try again.' }, { status: 401 });
      }
    } catch (sdkErr: any) {
      console.warn('[DirectAuth] Supabase REST SDK failed/timed out:', sdkErr?.message || sdkErr);
    }

    return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
  } catch (err: any) {
    console.error('[DirectAuth] Unexpected error:', err);
    return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
  }
}
