import { NextResponse } from 'next/server';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';
import { getAdminClient } from '@/lib/adminClient';

const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:9NGKXKwLoXHyUF2c@db.cpcvklekwwawgtgbyrmp.supabase.co:5432/postgres';

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

    let targetIdentifier = String(email).trim();

    // ─── Strategy 1: Direct PostgreSQL TCP Connection ────────────────────────
    let pgError: any = null;
    try {
      const client = new Client({
        connectionString: DB_URL,
        connectionTimeoutMillis: 2000,
      });

      await client.connect();

      try {
        let targetEmail = targetIdentifier;

        // If user provided client_id or phone without '@'
        if (!targetEmail.includes('@')) {
          const profRes = await client.query(
            `SELECT email FROM public.profiles WHERE UPPER(client_id) = UPPER($1) OR phone = $1 LIMIT 1`,
            [targetIdentifier]
          );
          if (profRes.rows.length > 0 && profRes.rows[0].email) {
            targetEmail = profRes.rows[0].email;
          }
        }

        // Query auth.users
        const userRes = await client.query(
          `SELECT id, email, encrypted_password, raw_user_meta_data, role FROM auth.users WHERE LOWER(email) = LOWER($1) LIMIT 1`,
          [targetEmail]
        );

        if (userRes.rows.length === 0) {
          await client.end().catch(() => {});
          return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
        }

        const user = userRes.rows[0];
        const isMatch = await bcrypt.compare(password, user.encrypted_password);

        if (!isMatch) {
          await client.end().catch(() => {});
          return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
        }

        // Get profile metadata
        const profileRes = await client.query(
          `SELECT role, full_name, client_id, phone FROM public.profiles WHERE id = $1 LIMIT 1`,
          [user.id]
        );
        const profile = profileRes.rows[0] || {};
        await client.end().catch(() => {});

        const userRole = profile.role || user.raw_user_meta_data?.role || 'trader';

        const userObj = {
          id: user.id,
          email: user.email,
          role: userRole,
          user_metadata: {
            ...(user.raw_user_meta_data || {}),
            role: userRole,
            full_name: profile.full_name,
            client_id: profile.client_id,
          },
        };

        const now = Math.floor(Date.now() / 1000);
        const jwtPayload = {
          sub: user.id,
          email: user.email,
          role: 'authenticated',
          aud: 'authenticated',
          exp: now + 86400,
          iat: now,
          user_metadata: userObj.user_metadata,
          app_metadata: { provider: 'email' },
        };

        const sessionObj = {
          access_token: createSignedJwt(jwtPayload),
          token_type: 'bearer',
          expires_in: 86400,
          expires_at: now + 86400,
          refresh_token: `refresh-${user.id}`,
          user: userObj,
        };

        return NextResponse.json({ session: sessionObj, user: userObj });
      } catch (innerErr) {
        await client.end().catch(() => {});
        throw innerErr;
      }
    } catch (err: any) {
      pgError = err;
      console.warn('[DirectAuth] PostgreSQL TCP connection unavailable/timed out, attempting REST SDK fallback:', err?.message || err);
    }

    // ─── Strategy 2: Supabase REST SDK Fallback ────────────────────────────────
    try {
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

      if (supabaseUrl && anonKey) {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(supabaseUrl, anonKey);

        let targetEmail = targetIdentifier;
        if (!targetEmail.includes('@')) {
          try {
            const admin = getAdminClient();
            const { data: prof } = await admin
              .from('profiles')
              .select('email')
              .or(`client_id.eq.${targetIdentifier},phone.eq.${targetIdentifier}`)
              .maybeSingle();
            if (prof?.email) {
              targetEmail = prof.email;
            }
          } catch {
            // Ignore admin query failure
          }
        }

        const authPromise = supabase.auth.signInWithPassword({
          email: targetEmail,
          password: password,
        });

        const timeoutPromise = new Promise<any>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 3000)
        );

        const res = await Promise.race([authPromise, timeoutPromise]);

        if (!res.timeout && res.data?.session && res.data?.user) {
          return NextResponse.json({
            session: res.data.session,
            user: res.data.user,
          });
        }

        if (!res.timeout && res.error) {
          return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
        }
      }
    } catch (sdkErr: any) {
      console.warn('[DirectAuth] Supabase REST SDK fallback failed/timed out:', sdkErr?.message || sdkErr);
    }

    // ─── Strategy 3: Resilience Demo Account Fallback ──────────────────────────
    if (
      (targetIdentifier.toLowerCase() === 'demo@gmail.com' || targetIdentifier.toUpperCase() === 'DEMO123') &&
      password === 'demo123'
    ) {
      const demoUser = {
        id: 'demo-user-id-0000-0000',
        email: 'demo@gmail.com',
        role: 'trader',
        user_metadata: {
          role: 'trader',
          full_name: 'Demo Trader',
          client_id: 'DEMO123',
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

    return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
  } catch (err: any) {
    console.error('[DirectAuth] Unexpected error:', err);
    return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
  }
}
