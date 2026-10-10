import { SupabaseClient } from '@supabase/supabase-js';

/**
 * Logs an administrative action to audit_logs (Railway Postgres first, fallback to Supabase).
 */
export async function auditLog(
  adminClient: SupabaseClient,
  actorId: string,
  targetId: string | null,
  action: string,
  metadata: Record<string, any> = {}
): Promise<void> {
  // 1. Try Railway Postgres first
  try {
    const { isRailwayDbConfigured, logAuditToRailway } = await import('./railway-db');
    if (isRailwayDbConfigured()) {
      const logged = await logAuditToRailway(actorId, targetId, action, metadata);
      if (logged) return;
    }
  } catch (err: any) {
    console.warn('[auditLog] Railway Postgres logging failed, falling back to Supabase:', err.message);
  }

  // 2. Fallback to Supabase
  const { error } = await adminClient
    .from('audit_logs')
    .insert({
      actor_id: actorId,
      target_id: targetId,
      action: action,
      metadata: metadata
    });

  if (error) {
    console.error('[auditLog] Failed to insert audit log to Supabase:', error);
  }
}
