/**
 * useMyPositions
 * 
 * Fetches internal platform positions from /api/positions and
 * enriches them with live LTP from Zerodha Kite.
 * Refactored to delegate to global PositionsContext.
 */

'use client';

import { usePositionsData, EnrichedPosition } from '@/contexts/PositionsContext';
import { MyPosition } from '@/lib/types/order';

export type { EnrichedPosition };

interface UseMyPositionsResult {
  positions: EnrichedPosition[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  updatePositionLocally: (posId: string, updatedFields: Partial<MyPosition>) => void;
  removePositionLocally: (posId: string) => void;
  restorePositionLocally: (posId: string) => void;
  startConversion: (posId: string, newType: string) => void;
  endConversion: (posId: string) => void;
  addOptimisticPosition: (pos: Partial<MyPosition>) => void;
}

export function useMyPositions(refreshInterval?: number): UseMyPositionsResult {
  return usePositionsData();
}
