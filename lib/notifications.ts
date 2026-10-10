import { SupabaseClient } from '@supabase/supabase-js';
import {
  isRailwayDbConfigured,
  insertNotificationsToRailway,
  getUserNotificationsFromRailway,
  markNotificationsReadInRailway,
  type NotificationRow
} from './railway-db';

/**
 * Sends notifications (Railway Postgres first, fallback to Supabase).
 */
export async function sendNotifications(
  adminClient: SupabaseClient,
  notifications: NotificationRow | NotificationRow[]
): Promise<boolean> {
  const list = Array.isArray(notifications) ? notifications : [notifications];
  if (list.length === 0) return true;

  // 1. Try Railway Postgres first
  if (isRailwayDbConfigured()) {
    try {
      const ok = await insertNotificationsToRailway(list);
      if (ok) return true;
    } catch (err: any) {
      console.warn('[notifications] Railway Postgres insert failed, falling back to Supabase:', err.message);
    }
  }

  // 2. Fallback to Supabase
  try {
    const CHUNK_SIZE = 100;
    for (let i = 0; i < list.length; i += CHUNK_SIZE) {
      const chunk = list.slice(i, i + CHUNK_SIZE);
      const { error } = await adminClient.from('notifications').insert(chunk);
      if (error) {
        console.error('[notifications] Supabase insert error:', error.message);
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error('[notifications] Supabase insert exception:', err);
    return false;
  }
}

/**
 * Fetches user notifications (Railway Postgres first, fallback to Supabase).
 */
export async function fetchUserNotifications(
  adminClient: SupabaseClient,
  userId: string,
  limit: number = 50,
  unreadOnly: boolean = false
): Promise<{ notifications: any[]; unread_count: number; storage: string } | null> {
  // 1. Try Railway Postgres first
  if (isRailwayDbConfigured()) {
    try {
      const rows = await getUserNotificationsFromRailway(userId, limit, unreadOnly);
      if (rows !== null && rows.length > 0) {
        const filtered = rows.filter((n: any) => {
          const t = n.title ?? '';
          return !t.startsWith('[Market Open]') && !t.startsWith('[Market Close]') && !t.startsWith('[Market Closed]');
        });
        const unreadCount = filtered.filter((n: any) => !n.read).length;
        return { notifications: filtered, unread_count: unreadCount, storage: 'railway' };
      }
    } catch (err: any) {
      console.warn('[notifications] Railway Postgres query failed, falling back to Supabase:', err.message);
    }
  }

  // 2. Fallback to Supabase
  try {
    let query = adminClient
      .from('notifications')
      .select('id, type, title, message, read, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (unreadOnly) query = query.eq('read', false);

    const { data, error } = await query;
    if (error) {
      console.error('[notifications] Supabase query error:', error);
      return null;
    }

    const filtered = (data ?? []).filter((n: any) => {
      const t = n.title ?? '';
      return !t.startsWith('[Market Open]') && !t.startsWith('[Market Close]') && !t.startsWith('[Market Closed]');
    });
    const unreadCount = filtered.filter((n: any) => !n.read).length;
    return { notifications: filtered, unread_count: unreadCount, storage: 'supabase' };
  } catch (err) {
    console.error('[notifications] Supabase query exception:', err);
    return null;
  }
}

/**
 * Marks notifications as read across Railway Postgres and Supabase.
 */
export async function updateNotificationsRead(
  adminClient: SupabaseClient,
  userId: string,
  id: string
): Promise<boolean> {
  let ok = false;

  if (isRailwayDbConfigured()) {
    try {
      await markNotificationsReadInRailway(userId, id);
      ok = true;
    } catch (err: any) {
      console.warn('[notifications] Railway Postgres update read failed:', err.message);
    }
  }

  try {
    if (id === 'all') {
      await adminClient
        .from('notifications')
        .update({ read: true })
        .eq('user_id', userId)
        .eq('read', false);
    } else {
      await adminClient
        .from('notifications')
        .update({ read: true })
        .eq('id', id)
        .eq('user_id', userId);
    }
    ok = true;
  } catch (err: any) {
    console.error('[notifications] Supabase update read error:', err.message);
  }

  return ok;
}
