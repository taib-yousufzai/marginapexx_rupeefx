import { requireAuth } from '@/lib/api-middleware';
import { getPlatformSetting, setPlatformSetting } from '@/lib/getPlatformSetting';

const ALLOWED_SETTINGS = [
  'EXIT_PRICE_MODE',
  'MAINTENANCE_MODE',
  'GLOBAL_KILL_SWITCH',
  'ALLOW_REGISTRATIONS',
  'USD_INR_RATE',
  'SUPPORT_WHATSAPP_NUMBER',
  'WHATSAPP_COMMUNITY_LINK',
] as const;
type AllowedSetting = typeof ALLOWED_SETTINGS[number];

const DEFAULTS: Record<AllowedSetting, string> = {
  EXIT_PRICE_MODE: 'BID_ASK',
  MAINTENANCE_MODE: 'false',
  GLOBAL_KILL_SWITCH: 'false',
  ALLOW_REGISTRATIONS: 'true',
  USD_INR_RATE: '83.50',
  SUPPORT_WHATSAPP_NUMBER: '918796119115',
  WHATSAPP_COMMUNITY_LINK: 'https://chat.whatsapp.com/BqxIlyVnRQNIJ2JB2swEVh',
};

const VALID_VALUES: Partial<Record<AllowedSetting, string[]>> = {
  EXIT_PRICE_MODE: ['BID_ASK', 'LTP'],
  MAINTENANCE_MODE: ['true', 'false'],
  GLOBAL_KILL_SWITCH: ['true', 'false'],
  ALLOW_REGISTRATIONS: ['true', 'false'],
};

/** GET /api/admin/platform-settings — returns all platform settings */
export async function GET(request: Request) {
  const auth = await requireAuth(request, ['VIEW_USERS']);
  if (auth instanceof Response) return auth;

  const adminId = auth.callerUser.id;
  const settings: Record<string, string> = {};
  for (const key of ALLOWED_SETTINGS) {
    if (key === 'SUPPORT_WHATSAPP_NUMBER' || key === 'WHATSAPP_COMMUNITY_LINK') {
      // 1. Check scoped setting for this admin ID (use __NOT_SET__ sentinel to distinguish empty string from unset)
      let val = await getPlatformSetting(`${key}:${adminId}`, '__NOT_SET__');

      // 2. If phone number and not yet configured, check admin profile phone
      if (val === '__NOT_SET__' && key === 'SUPPORT_WHATSAPP_NUMBER') {
        try {
          const { data: prof } = await auth.adminClient
            .from('profiles')
            .select('phone')
            .eq('id', adminId)
            .maybeSingle();
          if (prof?.phone && prof.phone.trim()) {
            val = prof.phone.trim();
          }
        } catch {}
      }

      // 3. Fallback to global setting / default only if genuinely not set
      if (val === '__NOT_SET__') {
        val = await getPlatformSetting(key, DEFAULTS[key]);
      }
      settings[key] = val;
    } else {
      settings[key] = await getPlatformSetting(key, DEFAULTS[key]);
    }
  }

  return Response.json({ settings });
}

/** PUT /api/admin/platform-settings — updates one or more platform settings */
export async function PUT(request: Request) {
  const auth = await requireAuth(request, ['VIEW_USERS']);
  if (auth instanceof Response) return auth;

  const adminId = auth.callerUser.id;
  const isSuperAdmin = auth.callerRole === 'super_admin';
  const metaClientId = (auth.callerUser.user_metadata?.client_id || auth.callerUser.user_metadata?.username || '').trim();

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const updated: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(body)) {
    if (!ALLOWED_SETTINGS.includes(key as AllowedSetting)) {
      errors.push(`Unknown setting: ${key}`);
      continue;
    }
    if (key === 'USD_INR_RATE') {
      const num = parseFloat(value);
      if (isNaN(num) || num <= 0) {
        errors.push('USD_INR_RATE must be a positive number');
        continue;
      }
    } else {
      const valid = VALID_VALUES[key as AllowedSetting];
      if (valid && !valid.includes(value)) {
        errors.push(`${key} must be one of: ${valid.join(', ')}`);
        continue;
      }
    }

    if (key === 'SUPPORT_WHATSAPP_NUMBER' || key === 'WHATSAPP_COMMUNITY_LINK') {
      // 1. Save scoped setting for this admin ID
      await setPlatformSetting(`${key}:${adminId}`, value);

      // 2. Also save scoped for client ID if present (e.g. FOT290, OCX39Z)
      if (metaClientId) {
        await setPlatformSetting(`${key}:${metaClientId}`, value);
      }

      // 3. Also save scoped for WHITELABEL_BROKER_ID if present in environment
      const brokerEnvId = (process.env.WHITELABEL_BROKER_ID || process.env.NEXT_PUBLIC_WHITELABEL_BROKER_ID || '').trim();
      if (brokerEnvId) {
        await setPlatformSetting(`${key}:${brokerEnvId}`, value);
      }

      // 4. Sync profile phone for this admin
      if (key === 'SUPPORT_WHATSAPP_NUMBER') {
        try {
          await auth.adminClient
            .from('profiles')
            .update({ phone: value })
            .eq('id', adminId);
        } catch (err) {
          console.warn('[platform-settings] Failed to sync profile phone:', err);
        }
      }

      // 5. If super_admin, also update the global fallback key
      if (isSuperAdmin) {
        await setPlatformSetting(key, value);
      }
    } else {
      await setPlatformSetting(key, value);
    }
    updated.push(key);
  }

  if (errors.length > 0 && updated.length === 0) {
    return Response.json({ error: errors.join('; ') }, { status: 400 });
  }

  return Response.json({ updated, errors });
}

