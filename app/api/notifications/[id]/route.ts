import { NextRequest, NextResponse } from 'next/server';
import { getAdminClient, getUserFromRequest } from '@/lib/adminClient';
import { updateNotificationsRead } from '@/lib/notifications';

/**
 * PATCH /api/notifications/[id]
 * Mark a single notification as read.
 *
 * PATCH /api/notifications/all  (special id)
 * Mark ALL notifications as read.
 */
export async function PATCH(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const user = await getUserFromRequest(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { id } = await params;
    const admin = getAdminClient();

    const ok = await updateNotificationsRead(admin, user.id, id);
    if (!ok) {
        return NextResponse.json({ error: 'Failed to update' }, { status: 500 });
    }

    return NextResponse.json({ success: true });
}
