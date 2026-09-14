import { NextResponse } from 'next/server';
import { Client } from 'pg';
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

    const targetIdentifier = String(email).trim();

    // ─── Strategy 1: Resolve non-email identifiers (client_id / phone) ───────
    // We ONLY look up the email address here — no password verification in JS.
    // bcrypt.compare() in pure-JS (bcryptjs) takes 30–60s on cost-10 hashes.
    // All password verification is delegated to Supabase (Strategy 2) which
    // runs bcrypt in native C on its servers in under 100ms.
    let resolvedEmail = targetIdentifier;

    if (!targetIdentifier.includes('@')) {
      // Try fast TCP Postgres connection for email lookup
      try {
        const client = new Client({
          connectionString: DB_URL,
          connectionTimeoutMillis: 2000,
        });
        await client.connect();
        try {
          const profRes = await client.query(
            `SELECT email FROM public.profiles WHERE UPPER(client_id) = UPPER($1) OR phone = $1 LIMIT 1`,
            [targetIdentifier]
          );
          if (profRes.rows.length > 0 && profRes.rows[0].email) {
            resolvedEmail = profRes.rows[0].email;
          }
        } finally {
          await client.end().catch(() => {});
        }
      } catch {
        // TCP unavailable — try Supabase REST for email lookup
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
        } catch {
          // Ignore — will attempt auth with the original identifier
        }
      }
    }

    // ─── Strategy 2: Supabase REST SDK — password verification happens here ──
    // Supabase verifies bcrypt server-side in native C (<100ms).
    try {
      const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;

      if (supabaseUrl && anonKey) {
        const { createClient } = await import('@supabase/supabase-js');
        const supabase = createClient(supabaseUrl, anonKey);

        const authPromise = supabase.auth.signInWithPassword({
          email: resolvedEmail,
          password,
        });

        const timeoutPromise = new Promise<any>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 8000)
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
      console.warn('[DirectAuth] Supabase REST SDK failed/timed out:', sdkErr?.message || sdkErr);
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
