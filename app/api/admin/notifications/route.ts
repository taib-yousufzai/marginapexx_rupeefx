/**
 * POST /api/admin/notifications
 * 
 * Sends notifications to users.
 * Supports targeting:
 * - Specific User
 * - Broker Users (All users under a specific parent_id)
 * - All Users
 */

import { requireAdmin } from '../_auth';

export async function POST(request: Request) {
  try {
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    const body = await request.json();
    const { target, userId, title, message } = body;

    if (!title || !message) {
      return Response.json({ error: 'Title and message are required' }, { status: 400 });
    }

    let targetUserIds: string[] = [];

    if (target === 'Specific User' || target === 'all') { // 'all' used by SettingsBroadcaster
      if (userId) {
        targetUserIds = [userId];
      } else if (target === 'all') {
         // Fetch all users
         const { data, error } = await adminClient.from('profiles').select('id');
         if (!error && data) targetUserIds = data.map(u => u.id);
      }
    } else if (target === 'Broker Users') {
      // Fetch all users where parent_id matches the selected user (who is likely a broker)
      // Actually, targeted notifications in Update tab usually target the selected user's sub-users if they are a broker.
      const { data, error } = await adminClient.from('profiles').select('id').eq('parent_id', userId);
      if (!error && data) targetUserIds = data.map(u => u.id);
    } else if (target === 'All Users') {
      const { data, error } = await adminClient.from('profiles').select('id');
      if (!error && data) targetUserIds = data.map(u => u.id);
    } else if (target === 'active') {
      const { data, error } = await adminClient.from('profiles').select('id').eq('active', true);
      if (!error && data) targetUserIds = data.map(u => u.id);
    } else if (target === 'brokers') {
      const { data, error } = await adminClient.from('profiles').select('id').eq('role', 'broker');
      if (!error && data) targetUserIds = data.map(u => u.id);
    }

    if (targetUserIds.length === 0) {
      return Response.json({ error: 'No target users found' }, { status: 404 });
    }

    // Insert notifications in chunks to avoid payload size limits if many users
    const notifications = targetUserIds.map(id => ({
      user_id: id,
      type: 'GENERAL',
      title,
      message,
      read: false,
      created_at: new Date().toISOString()
    }));

    // Chunk size 100
    const chunkSize = 100;
    for (let i = 0; i < notifications.length; i += chunkSize) {
      const chunk = notifications.slice(i, i + chunkSize);
      const { error } = await adminClient.from('notifications').insert(chunk);
      if (error) {
        console.error('[POST notifications] Insert error:', error.message);
        return Response.json({ error: 'Failed to send some notifications' }, { status: 500 });
      }
    }

    return Response.json({ 
      success: true, 
      count: targetUserIds.length,
      message: `Notification sent to ${targetUserIds.length} users`
    }, { status: 200 });

  } catch (error: any) {
    console.error('[POST notifications] Unexpected error:', error);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}
