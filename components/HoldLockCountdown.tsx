'use client';

import { useState, useEffect } from 'react';
import type { EnrichedPosition } from '@/hooks/useMyPositions';

interface HoldLockCountdownProps {
  pos: EnrichedPosition;
  /** CSS class applied to the root span. Defaults to monospace styling. */
  className?: string;
  style?: React.CSSProperties;
}

/**
 * HoldLockCountdown
 *
 * A self-contained 1-second timer that displays the remaining hold-lock
 * duration for a single position.
 *
 * IMPORTANT: Only this component re-renders every second.
 * The parent PositionPage and every other position row are unaffected.
 *
 * Previously the entire PositionPage re-rendered every second via a
 * page-level `setTickCount` interval. Extracting the timer here means
 * the interval only causes one lightweight span update instead of a
 * full page reconciliation.
 *
 * Usage:
 *   <HoldLockCountdown pos={lockModalPos} />
 */
export default function HoldLockCountdown({ pos, className, style }: HoldLockCountdownProps) {
  const [remaining, setRemaining] = useState(() => computeRemaining(pos));

  useEffect(() => {
    // Recompute immediately when pos changes (e.g. modal opens for a new position)
    setRemaining(computeRemaining(pos));

    if (!pos.hold_lock_active) return;

    const id = setInterval(() => {
      const next = computeRemaining(pos);
      setRemaining(next);
      // Stop ticking once the lock expires — avoids negative display
      if (next <= 0) clearInterval(id);
    }, 1000);

    return () => clearInterval(id);
  }, [pos.id, pos.hold_lock_active, pos.required_hold_seconds, pos.entry_time]);

  return (
    <span
      className={className}
      style={{ fontFamily: 'monospace', ...style }}
    >
      {fmtHoldTime(remaining)}
    </span>
  );
}

// ─── Helpers (module-scoped so they're pure and don't cause re-renders) ──────

function computeRemaining(pos: EnrichedPosition): number {
  if (!pos.hold_lock_active) return 0;
  const rawTime = pos.entry_time || (pos as any).created_at;
  const entryMs = rawTime ? new Date(rawTime).getTime() : Date.now();
  if (isNaN(entryMs)) return 0;
  const elapsed = Math.floor((Date.now() - entryMs) / 1000);
  const remaining = pos.required_hold_seconds - elapsed;
  return remaining > 0 ? remaining : 0;
}

function fmtHoldTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}
