import { getRedisClient } from '@/lib/redis';
import { getAdminClient } from '@/lib/adminClient';

const MEM_PLATFORM_SETTINGS = new Map<string, { value: string; expiresAt: number }>();

export async function getPlatformSetting(
  key: string,
  fallback: string,
): Promise<string> {
  // 1. Env variable priority override
  const envVal = process.env[key];
  if (envVal) return envVal;

  const now = Date.now();
  // 2. Instant L1 in-memory cache (<0.01ms)
  const mem = MEM_PLATFORM_SETTINGS.get(key);
  if (mem && mem.expiresAt > now) {
    return mem.value;
  }

  // 3. Try Redis cache (with 100ms fast safety guard)
  try {
    const redis = getRedisClient();
    if (redis) {
      const val = await Promise.race([
        redis.get(`platform:${key}`),
        new Promise(r => setTimeout(() => r(null), 100))
      ]) as string | null;
      if (val !== null && val !== undefined) {
        MEM_PLATFORM_SETTINGS.set(key, { value: val, expiresAt: now + 60_000 });
        return val;
      }
    }
  } catch (err) {
    // Ignore Redis error
  }

  // 4. Fallback to Supabase platform_settings table
  try {
    const admin = getAdminClient();
    const { data } = await admin
      .from('platform_settings')
      .select('value')
      .eq('key', key)
      .single();

    if (data && data.value !== null && data.value !== undefined) {
      MEM_PLATFORM_SETTINGS.set(key, { value: data.value, expiresAt: now + 60_000 });
      // Warm Redis cache in background
      (async () => {
        try {
          const redis = getRedisClient();
          if (redis) {
            await redis.set(`platform:${key}`, data.value);
          }
        } catch {}
      })();
      return data.value;
    }
  } catch (err) {
    // Fallback if table or DB error
  }

  return fallback;
}

export async function setPlatformSetting(key: string, value: string): Promise<void> {
  // 1. Persist to Supabase DB
  try {
    const admin = getAdminClient();
    await admin
      .from('platform_settings')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  } catch (err) {
    console.error(`[setPlatformSetting] Supabase error for key ${key}:`, err);
  }

  // 2. Persist to Redis cache
  try {
    const redis = getRedisClient();
    if (redis) {
      await redis.set(`platform:${key}`, value);
    }
  } catch (err) {
    console.error(`[setPlatformSetting] Redis error for platform:${key}`, err);
  }
}
