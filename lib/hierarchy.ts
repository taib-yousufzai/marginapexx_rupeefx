import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Checks if a target user exists within the hierarchy of an actor user.
 * 
 * Rules:
 * - Super Admins have visibility over everyone.
 * - Admins can view/manage Brokers they created, and Users under those Brokers.
 * - Brokers can view/manage their own Users.
 * - Users can only view themselves.
 */
export async function isUserInHierarchy(
  supabase: SupabaseClient,
  actorId: string,
  targetUserId: string
): Promise<boolean> {
  // Trivially true if actor is the target
  if (actorId === targetUserId) {
    return true;
  }

  // Fetch actor's role
  const { data: actorData, error: actorError } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', actorId)
    .single();

  if (actorError || !actorData) {
    console.error('Error fetching actor role:', actorError);
    return false;
  }

  const role = actorData.role;

  // Super admins have platform-wide visibility across everyone
  if (role === 'super_admin') {
    return true;
  }

  // Users cannot see anyone else
  if (role === 'user') {
    return false;
  }

  // Fetch the target user's ancestry
  let currentTargetId: string | null = targetUserId;
  let depth = 0;
  const MAX_DEPTH = 5;

  while (currentTargetId && depth < MAX_DEPTH) {
    const { data: targetData, error: targetError } = await supabase
      .from('profiles')
      .select('parent_id, created_by')
      .eq('id', currentTargetId)
      .single() as { data: any, error: any };

    if (targetError || !targetData) {
      break;
    }

    if (targetData.parent_id === actorId || targetData.created_by === actorId) {
      return true;
    }

    currentTargetId = targetData.parent_id;
    depth++;
  }

  return false;
}

/**
 * Returns the list of accessible descendant user/profile IDs for a given actor according to hierarchy.
 * Returns null ONLY if the actor is super_admin (meaning unrestricted platform-wide access).
 * Admins and Brokers only receive their own ID and descendant user IDs.
 */
export async function getDescendantUserIds(
  supabase: SupabaseClient,
  actorId: string,
  actorRole: string
): Promise<string[] | null> {
  if (actorRole === 'super_admin') {
    return null; // Super admin has unrestricted platform-wide access
  }

  const { data: allProfiles, error } = await supabase
    .from('profiles')
    .select('id, parent_id, created_by');

  if (error || !allProfiles) {
    console.error('Error fetching hierarchy profiles:', error);
    return [actorId];
  }

  const getChildren = (parentId: string): string[] => {
    const directChildren = allProfiles.filter(p => p.parent_id === parentId || p.created_by === parentId).map(p => p.id);
    const indirectChildren = directChildren.flatMap(childId => getChildren(childId));
    return Array.from(new Set([...directChildren, ...indirectChildren]));
  };

  const descendants = getChildren(actorId);
  return [actorId, ...descendants];
}

