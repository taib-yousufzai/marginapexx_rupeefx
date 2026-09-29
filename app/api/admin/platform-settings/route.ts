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
  SUPPORT_WHATSAPP_NUMBER: '',
  WHATSAPP_COMMUNITY_LINK: '',
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

  const settings: Record<string, string> = {};
  for (const key of ALLOWED_SETTINGS) {
    settings[key] = await getPlatformSetting(key, DEFAULTS[key]);
  }

  return Response.json({ settings });
}

/** PUT /api/admin/platform-settings — updates one or more platform settings */
export async function PUT(request: Request) {
  const auth = await requireAuth(request, ['VIEW_USERS']);
  if (auth instanceof Response) return auth;

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
    await setPlatformSetting(key, value);
    updated.push(key);
  }

  if (errors.length > 0 && updated.length === 0) {
    return Response.json({ error: errors.join('; ') }, { status: 400 });
  }

  return Response.json({ updated, errors });
}

