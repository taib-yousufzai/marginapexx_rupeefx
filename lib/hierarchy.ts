import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Checks if a target user exists within the hierarchy of an actor user.
 * 
 * Rules:
 * - Super Admins have visibility over everyone.
 * - Admins can view/manage Brokers they created, and Users under those Brokers (and direct Users).
 * - Brokers can view/manage their own Users.
 * - Users can only view themselves.
 */
export async function isUserInHierarchy(
  supabase: SupabaseClient,
  actorId: string,
  targetUserId: string,
  actorRole?: string
): Promise<boolean> {
  // Trivially true if actor is the target
  if (actorId === targetUserId) {
    return true;
  }

  let role = actorRole;

  // Fetch actor's role if not provided
  if (!role) {
    const { data: actorData, error: actorError } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', actorId)
      .single();

    if (actorError || !actorData) {
      console.error('Error fetching actor role:', actorError);
      return false;
    }

    role = actorData.role;
  }

  // Super admins see everyone
  if (role === 'super_admin') {
    return true;
  }

  // Users cannot see anyone else
  if (role === 'user') {
    return false;
  }

  // Demo accounts belong to everyone: admins and brokers can view/manage demo users
  if (role === 'admin' || role === 'broker') {
    const { data: targetProfile } = await supabase
      .from('profiles')
      .select('demo_user')
      .eq('id', targetUserId)
      .single() as { data: any, error: any };

    if (targetProfile?.demo_user === true) {
      return true;
    }
  }

  // Walk up the target user's ancestry tree.
  // Maximum traversal depth of 10 to support deep hierarchies.
  let currentTargetId: string | null = targetUserId;
  let depth = 0;
  const MAX_DEPTH = 10;

  while (currentTargetId && depth < MAX_DEPTH) {
    const { data: targetData, error: targetError } = await supabase
      .from('profiles')
      .select('parent_id')
      .eq('id', currentTargetId)
      .single() as { data: any, error: any };

    if (targetError || !targetData) {
      break;
    }

    if (targetData.parent_id === actorId) {
      return true;
    }

    currentTargetId = targetData.parent_id;
    depth++;
  }

  return false;
}

/**
 * Returns the list of accessible descendant user/profile IDs for a given actor according to hierarchy.
 * Returns null if the actor is super_admin (meaning unrestricted access to all users).
 */
export async function getDescendantUserIds(
  supabase: SupabaseClient,
  actorId: string,
  actorRole: string
): Promise<string[] | null> {
  if (actorRole === 'super_admin') {
    return null; // Unrestricted access across system
  }

  const { data: allProfiles, error } = await supabase
    .from('profiles')
    .select('id, parent_id');

  if (error || !allProfiles) {
    console.error('Error fetching hierarchy profiles:', error);
    return [];
  }

  const getChildren = (parentId: string): string[] => {
    const directChildren = allProfiles.filter(p => p.parent_id === parentId).map(p => p.id);
    const indirectChildren = directChildren.flatMap(childId => getChildren(childId));
    return [...directChildren, ...indirectChildren];
  };

  return getChildren(actorId);
}

/**
 * Guard that verifies if target user is in actor's hierarchy.
 * Returns 403 Response if access denied, or null if allowed.
 */
export async function assertUserInHierarchy(
  supabase: SupabaseClient,
  actorId: string,
  targetUserId: string,
  actorRole?: string
): Promise<Response | null> {
  const allowed = await isUserInHierarchy(supabase, actorId, targetUserId, actorRole);
  if (!allowed) {
    return Response.json({ error: 'Forbidden: User not in your hierarchy' }, { status: 403 });
  }
  return null;
}

