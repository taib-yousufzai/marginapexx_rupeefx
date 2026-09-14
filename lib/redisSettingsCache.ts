import { getRedisClient, isRedisMock } from './redis';

export interface ScriptSettingItem {
  symbol: string;
  lot_size: number;
}

const MEM_SCRIPT_SETTINGS = new Map<string, number>();
let scriptSettingsExpiry = 0;

/**
 * Get all script lot sizes using Redis + memory caching (1-hour TTL).
 * Drastically reduces Supabase DB load on order placement.
 */
export async function getCachedScriptSettings(getSupabaseAdmin: () => any): Promise<Record<string, number>> {
  const now = Date.now();
  if (MEM_SCRIPT_SETTINGS.size > 0 && scriptSettingsExpiry > now) {
    return Object.fromEntries(MEM_SCRIPT_SETTINGS);
  }

  const redis = getRedisClient();
  const redisKey = 'settings:script_lot_sizes';

  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      const parsed: Record<string, number> = JSON.parse(cached);
      MEM_SCRIPT_SETTINGS.clear();
      for (const [sym, lot] of Object.entries(parsed)) {
        MEM_SCRIPT_SETTINGS.set(sym, lot);
      }
      scriptSettingsExpiry = now + 3600 * 1000;
      return parsed;
    }
  } catch (_) {}

  // Fallback to Supabase query
  try {
    const admin = getSupabaseAdmin();
    const { data } = await admin.from('script_settings').select('symbol, lot_size');
    const result: Record<string, number> = {};

    if (data) {
      for (const item of data) {
        if (item.symbol && item.lot_size > 0) {
          result[item.symbol] = item.lot_size;
          MEM_SCRIPT_SETTINGS.set(item.symbol, item.lot_size);
        }
      }
    }

    scriptSettingsExpiry = now + 3600 * 1000;
    try {
      await redis.setex(redisKey, 3600, JSON.stringify(result));
    } catch (_) {}

    return result;
  } catch (err) {
    console.warn('[getCachedScriptSettings] Fallback error:', err);
    return Object.fromEntries(MEM_SCRIPT_SETTINGS);
  }
}

/**
 * Get user segment settings using Redis caching (10-minute TTL).
 */
export async function getCachedUserSegmentSettings(
  userId: string,
  segment: string,
  isScalper: boolean,
  getSupabaseAdmin: () => any
): Promise<any[]> {
  const redis = getRedisClient();
  const targetTable = isScalper ? 'scalper_segment_settings' : 'segment_settings';
  const redisKey = `user:seg_settings:${userId}:${segment}:${targetTable}`;

  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (_) {}

  try {
    const admin = getSupabaseAdmin();
    const { data } = await admin
      .from(targetTable)
      .select('*')
      .eq('user_id', userId)
      .eq('segment', segment);

    const result = data ?? [];
    try {
      await redis.setex(redisKey, 600, JSON.stringify(result));
    } catch (_) {}

    return result;
  } catch (err) {
    console.warn('[getCachedUserSegmentSettings] Fallback error:', err);
    return [];
  }
}

/**
 * Invalidate user segment settings in Redis when updated by admin.
 */
export async function invalidateUserSegmentSettings(userId: string): Promise<void> {
  const redis = getRedisClient();
  try {
    const keys = await redis.keys(`user:seg_settings:${userId}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (_) {}
}

/**
 * Get allowed template script symbols using Redis caching (1-hour TTL).
 */
export async function getCachedTemplateScripts(
  templateId: number,
  getSupabaseAdmin: () => any
): Promise<string[]> {
  if (!templateId) return [];
  const redis = getRedisClient();
  const redisKey = `template:scripts:${templateId}`;

  try {
    const cached = await redis.get(redisKey);
    if (cached) {
      return JSON.parse(cached);
    }
  } catch (_) {}

  try {
    const admin = getSupabaseAdmin();
    const { data: scripts } = await admin.from('template_scripts').select('symbol').eq('template_id', templateId);
    const result = (scripts || []).map((s: any) => s.symbol).filter(Boolean);

    try {
      await redis.setex(redisKey, 3600, JSON.stringify(result));
    } catch (_) {}

    return result;
  } catch (err) {
    console.warn('[getCachedTemplateScripts] Fallback error:', err);
    return [];
  }
}

/**
 * Invalidate template scripts cache in Redis when an admin updates a template.
 */
export async function invalidateTemplateScripts(templateId: number): Promise<void> {
  const redis = getRedisClient();
  try {
    await redis.del(`template:scripts:${templateId}`);
  } catch (_) {}
}
