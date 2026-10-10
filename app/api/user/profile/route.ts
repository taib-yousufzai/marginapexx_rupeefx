import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { logAction, extractClientIp } from '@/lib/actionLogger';
import { getPlatformSetting } from '@/lib/getPlatformSetting';
import { getRedisClient } from '@/lib/redis';

const ALLOWED_FIELDS = [
    'full_name', 'phone', 'date_of_birth',
    'city', 'state', 'pan_number',
    'bank_name', 'account_no', 'ifsc',
] as const;

// Module-level cache for the broker/whitelabel UUID — resolved once per process lifetime
// since it comes from env vars which never change at runtime.
let _brokerCache: { id: string | null; resolvedAt: number } | null = null;

async function resolveBrokerParentId(admin: ReturnType<typeof getAdminClient>): Promise<string | null> {
  // Return cached value if resolved in the last 10 minutes
  if (_brokerCache && (Date.now() - _brokerCache.resolvedAt) < 10 * 60 * 1000) {
    return _brokerCache.id;
  }

  const brokerIdentifier = process.env.WHITELABEL_BROKER_ID
    || process.env.NEXT_PUBLIC_WHITELABEL_BROKER_ID
    || process.env.WHITELABEL_BROKER_USERNAME
    || process.env.ADMIN_ID
    || process.env.NEXT_PUBLIC_ADMIN_ID
    || process.env.SUPER_ADMIN_ID;

  if (!brokerIdentifier) {
    _brokerCache = { id: null, resolvedAt: Date.now() };
    return null;
  }

  const cleanIdentifier = brokerIdentifier.trim();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanIdentifier);

  let resolvedId: string | null = null;
  if (isUuid) {
    // Already a UUID — no DB round-trip needed
    resolvedId = cleanIdentifier;
  } else {
    const { data } = await admin
      .from('profiles')
      .select('id')
      .or(`client_id.ilike.${cleanIdentifier},email.ilike.${cleanIdentifier}`)
      .maybeSingle();
    resolvedId = data?.id ?? null;
  }

  _brokerCache = { id: resolvedId, resolvedAt: Date.now() };
  return resolvedId;
}

export async function GET(request: NextRequest) {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    // --- Redis cache: 60s TTL ---
    let redis: ReturnType<typeof getRedisClient> | null = null;
    const cacheKey = `user_profile:${user.id}`;
    try {
      redis = getRedisClient();
      const cached = await Promise.race([
        redis.get(cacheKey),
        new Promise<null>(r => setTimeout(() => r(null), 150)),
      ]) as string | null;
      if (cached) {
        return NextResponse.json(JSON.parse(cached));
      }
    } catch { /* Redis unavailable — fall through to DB */ }

    const admin = getAdminClient();

    // Resolve static broker parent ID (module-level cached — near-instant on repeat calls)
    const envBrokerId = await resolveBrokerParentId(admin);

    // Fetch profile, bank, and platform settings all in parallel — single round-trip
    const [profileRes, bankRes, supportPhone, whatsappCommunityLink] = await Promise.all([
        admin
            .from('profiles')
            .select('id, client_id, full_name, email, phone, role, segments, created_at, date_of_birth, city, state, pan_number, bank_name, account_no, ifsc, webhook_token, trading_mode, template_id, referral_code, parent_id')
            .eq('id', user.id)
            .single(),
        admin
            .from('user_bank_accounts')
            .select('bank_name, account_no, ifsc')
            .eq('user_id', user.id)
            .eq('is_primary', true)
            .maybeSingle(),
        getPlatformSetting('SUPPORT_WHATSAPP_NUMBER', process.env.NEXT_PUBLIC_WHATSAPP_SUPPORT_NUMBER || '918796119115'),
        getPlatformSetting('WHATSAPP_COMMUNITY_LINK', process.env.NEXT_PUBLIC_WHATSAPP_COMMUNITY_LINK || 'https://chat.whatsapp.com/BqxIlyVnRQNIJ2JB2swEVh'),
    ]);

    if (profileRes.error || !profileRes.data) {
        return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const profile = profileRes.data;
    if (Array.isArray(profile.segments)) {
      profile.segments = profile.segments.map((s: string) => (s === 'NSE-EQ' || s === 'NSE - EQUITY' || s === 'Equity') ? 'STOCKS' : s);
    }

    if (bankRes.data) {
        profile.bank_name = bankRes.data.bank_name || profile.bank_name;
        profile.account_no = bankRes.data.account_no || profile.account_no;
        profile.ifsc = bankRes.data.ifsc || profile.ifsc;
    }

    const parentId = profile.parent_id || envBrokerId;
    let finalSupportPhone = supportPhone ? String(supportPhone).trim() : '';
    let finalCommunityLink = whatsappCommunityLink ? String(whatsappCommunityLink).trim() : '';

    if (parentId) {
      // 1. Check scoped platform settings for this broker parentId
      const [scopedPhone, scopedCommunity] = await Promise.all([
        getPlatformSetting(`SUPPORT_WHATSAPP_NUMBER:${parentId}`, '__NOT_SET__'),
        getPlatformSetting(`WHATSAPP_COMMUNITY_LINK:${parentId}`, '__NOT_SET__'),
      ]);

      if (scopedPhone !== '__NOT_SET__') {
        finalSupportPhone = scopedPhone.trim();
      } else {
        // Fallback to broker's profile phone
        const { data: brokerProfile } = await admin
          .from('profiles')
          .select('phone')
          .eq('id', parentId)
          .maybeSingle();
        if (brokerProfile?.phone?.trim()) {
          finalSupportPhone = brokerProfile.phone.trim();
        }
      }

      if (scopedCommunity !== '__NOT_SET__') {
        finalCommunityLink = scopedCommunity.trim();
      }
    } else if (process.env.WHITELABEL_BROKER_ID) {
      // Direct env fallback for whitelabels
      const envRef = process.env.WHITELABEL_BROKER_ID.trim();
      const [scopedPhone, scopedCommunity] = await Promise.all([
        getPlatformSetting(`SUPPORT_WHATSAPP_NUMBER:${envRef}`, '__NOT_SET__'),
        getPlatformSetting(`WHATSAPP_COMMUNITY_LINK:${envRef}`, '__NOT_SET__'),
      ]);
      if (scopedPhone !== '__NOT_SET__') finalSupportPhone = scopedPhone.trim();
      if (scopedCommunity !== '__NOT_SET__') finalCommunityLink = scopedCommunity.trim();
    }

    const responseData = {
        ...profile,
        support_phone: finalSupportPhone || '',
        whatsapp_community_link: finalCommunityLink || '',
    };

    // Cache in Redis for 60s (fire-and-forget)
    if (redis) {
      redis.set(cacheKey, JSON.stringify(responseData), 'EX', 60).catch(() => {});
    }

    return NextResponse.json(responseData);
}

export async function PATCH(request: NextRequest) {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    let body: Record<string, unknown>;
    try { body = await request.clone().json(); }
    catch { return NextResponse.json({ error: 'Invalid request body' }, { status: 400 }); }

    const updates: Record<string, string> = {};
    const loggedFields: Record<string, string> = {};
    for (const field of ALLOWED_FIELDS) {
        if (typeof body[field] === 'string') {
            const v = (body[field] as string).trim();
            updates[field] = v;
            loggedFields[field] = v;
        } else if (typeof body[field] === 'number') {
            const v = String(body[field]).trim();
            updates[field] = v;
            loggedFields[field] = v;
        }
    }

    if (Object.keys(updates).length === 0)
        return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 });

    const admin = getAdminClient();
    const bankUpdate: Record<string, string> = {};
    if (updates.bank_name) bankUpdate.bank_name = updates.bank_name;
    if (updates.account_no) bankUpdate.account_no = updates.account_no;
    if (updates.ifsc) bankUpdate.ifsc = updates.ifsc;

    delete updates.bank_name;
    delete updates.account_no;
    delete updates.ifsc;

    if (Object.keys(updates).length > 0) {
        const { error } = await admin.from('profiles').update(updates).eq('id', user.id);
        if (error) {
            console.error('[PATCH /api/user/profile]', error);
            return NextResponse.json({ error: 'Failed to update profile' }, { status: 500 });
        }
    }

    if (Object.keys(bankUpdate).length > 0) {
        const { data: updatedBank, error: bankUpdateError } = await admin
            .from('user_bank_accounts')
            .update(bankUpdate)
            .eq('user_id', user.id)
            .eq('is_primary', true)
            .select('id');

        if (bankUpdateError) {
            console.error('[PATCH /api/user/profile] Bank update error:', bankUpdateError);
            return NextResponse.json({ error: 'Failed to update bank details' }, { status: 500 });
        }

        if (!updatedBank || updatedBank.length === 0) {
            const { error: bankInsertError } = await admin
                .from('user_bank_accounts')
                .insert({
                    user_id: user.id,
                    bank_name: bankUpdate.bank_name || null,
                    account_no: bankUpdate.account_no || null,
                    ifsc: bankUpdate.ifsc || null,
                    is_primary: true
                });

            if (bankInsertError) {
                console.error('[PATCH /api/user/profile] Bank insert error:', bankInsertError);
                return NextResponse.json({ error: 'Failed to insert bank details' }, { status: 500 });
            }
        }
    }

    // Invalidate profile cache so next GET returns fresh data
    try {
      const redis = getRedisClient();
      await redis.del(`user_profile:${user.id}`);
    } catch { /* ignore */ }

    logAction({
      actionType: 'UPDATE_PROFILE',
      module: 'USER_PREFERENCES',
      apiEndpoint: '/api/user/profile',
      httpMethod: 'PATCH',
      ipAddress: extractClientIp(request.headers),
      userId: user.id,
      username: user.user_metadata?.username || user.email,
      role: user.user_metadata?.role,
      requestPayload: loggedFields,
      responseStatus: 200,
      isSuccess: true,
      metadata: { fields_updated: Object.keys(loggedFields) }
    });

    return NextResponse.json({ success: true });
}
