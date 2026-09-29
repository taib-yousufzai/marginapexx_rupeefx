import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { logAction, extractClientIp } from '@/lib/actionLogger';
import { getPlatformSetting } from '@/lib/getPlatformSetting';

const ALLOWED_FIELDS = [
    'full_name', 'phone', 'date_of_birth',
    'city', 'state', 'pan_number',
    'bank_name', 'account_no', 'ifsc',
] as const;

export async function GET(request: NextRequest) {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = getAdminClient();
    
    // Fetch profile, primary bank account, and platform support settings in parallel
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
    
    // Override with primary bank account if it exists
    if (bankRes.data) {
        profile.bank_name = bankRes.data.bank_name || profile.bank_name;
        profile.account_no = bankRes.data.account_no || profile.account_no;
        profile.ifsc = bankRes.data.ifsc || profile.ifsc;
    }

    // Resolve Support Phone based on assigned Broker / Whitelabel hierarchy (matching bank details resolution)
    let parentId = profile.parent_id;
    const brokerIdentifier = process.env.WHITELABEL_BROKER_ID
      || process.env.NEXT_PUBLIC_WHITELABEL_BROKER_ID
      || process.env.WHITELABEL_BROKER_USERNAME
      || process.env.ADMIN_ID
      || process.env.NEXT_PUBLIC_ADMIN_ID
      || process.env.SUPER_ADMIN_ID;

    if (!parentId && brokerIdentifier) {
      const cleanIdentifier = brokerIdentifier.trim();
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleanIdentifier);
      if (isUuid) {
        const { data } = await admin
          .from('profiles')
          .select('id, phone')
          .eq('id', cleanIdentifier)
          .maybeSingle();
        if (data?.id) parentId = data.id;
      } else {
        const { data } = await admin
          .from('profiles')
          .select('id, phone')
          .or(`client_id.ilike.${cleanIdentifier},email.ilike.${cleanIdentifier}`)
          .maybeSingle();
        if (data?.id) parentId = data.id;
      }
    }

    let finalSupportPhone = supportPhone ? String(supportPhone).trim() : '';
    if (parentId) {
      const { data: brokerProfile } = await admin
        .from('profiles')
        .select('phone')
        .eq('id', parentId)
        .maybeSingle();
      if (brokerProfile?.phone && brokerProfile.phone.trim()) {
        finalSupportPhone = brokerProfile.phone.trim();
      }
    }

    return NextResponse.json({
        ...profile,
        support_phone: finalSupportPhone || '',
        whatsapp_community_link: (whatsappCommunityLink ? String(whatsappCommunityLink).trim() : ''),
    });
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
    
    // Remove bank fields from profile update payload (sync only to bank accounts)
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

    // Also update primary bank account if bank fields are present
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
            // No primary bank account exists, insert one
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
