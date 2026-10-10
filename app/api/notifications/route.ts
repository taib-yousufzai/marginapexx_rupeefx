import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { fetchUserNotifications } from '@/lib/notifications';

/**
 * GET /api/notifications
 * Returns the authenticated user's notifications, newest first.
 * Query params: ?limit=20&unread_only=true
 */
export async function GET(request: NextRequest) {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { searchParams } = request.nextUrl;
    const limit      = Math.min(parseInt(searchParams.get('limit') ?? '50'), 100);
    const unreadOnly = searchParams.get('unread_only') === 'true';

    const admin = getAdminClient();
    const result = await fetchUserNotifications(admin, user.id, limit, unreadOnly);

    if (!result) {
        return NextResponse.json({ error: 'Failed to fetch notifications' }, { status: 500 });
    }

    return NextResponse.json({
        notifications: result.notifications,
        unread_count: result.unread_count,
        storage: result.storage
    });
}
