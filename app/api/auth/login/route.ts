import { NextResponse } from 'next/server';
import { Client } from 'pg';
import bcrypt from 'bcryptjs';

const DB_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres:9NGKXKwLoXHyUF2c@db.cpcvklekwwawgtgbyrmp.supabase.co:5432/postgres';

export async function POST(req: Request) {
  try {
    const { email, password } = await req.json();
    if (!email || !password) {
      return NextResponse.json({ error: 'Email/Username and password are required' }, { status: 400 });
    }

    let targetIdentifier = String(email).trim();

    const client = new Client({
      connectionString: DB_URL,
      connectionTimeoutMillis: 4000,
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
        await client.end();
        return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
      }

      const user = userRes.rows[0];
      const isMatch = await bcrypt.compare(password, user.encrypted_password);

      if (!isMatch) {
        await client.end();
        return NextResponse.json({ error: 'Invalid credentials. Please try again.' }, { status: 401 });
      }

      // Get profile metadata
      const profileRes = await client.query(
        `SELECT role, full_name, client_id, phone FROM public.profiles WHERE id = $1 LIMIT 1`,
        [user.id]
      );
      const profile = profileRes.rows[0] || {};
      await client.end();

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

      const sessionObj = {
        access_token: `direct-db-session-${user.id}-${Date.now()}`,
        token_type: 'bearer',
        expires_in: 86400,
        refresh_token: `refresh-${user.id}`,
        user: userObj,
      };

      return NextResponse.json({ session: sessionObj, user: userObj });
    } catch (dbErr: any) {
      await client.end().catch(() => {});
      console.error('[DirectAuth] DB Query error:', dbErr);
      return NextResponse.json({ error: 'Database authentication failed' }, { status: 500 });
    }
  } catch (err: any) {
    console.error('[DirectAuth] Unexpected error:', err);
    return NextResponse.json({ error: 'Authentication service error' }, { status: 500 });
  }
}
