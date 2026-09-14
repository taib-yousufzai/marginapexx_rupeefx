import { getRedisClient } from '@/lib/redis';
import { getAdminClient } from '@/lib/adminClient';

export async function getPlatformSetting(
  key: string,
  fallback: string,
): Promise<string> {
  // 1. Env variable priority override
  const envVal = process.env[key];
  if (envVal) return envVal;

  // 2. Try Redis cache (with 300ms fast safety guard)
  try {
    const redis = getRedisClient();
    if (redis) {
      const val = await Promise.race([
        redis.get(`platform:${key}`),
        new Promise(r => setTimeout(() => r(null), 300))
      ]) as string | null;
      if (val) return val;
    }
  } catch (err) {
    // Ignore Redis error
  }

  // 3. Fallback to Supabase platform_settings table
  try {
    const admin = getAdminClient();
    const { data } = await admin
      .from('platform_settings')
      .select('value')
      .eq('key', key)
      .single();

    if (data?.value) {
      // Warm Redis cache
      try {
        const redis = getRedisClient();
        if (redis) {
          await Promise.race([
            redis.set(`platform:${key}`, data.value),
            new Promise(r => setTimeout(r, 300))
          ]);
        }
      } catch {}
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
