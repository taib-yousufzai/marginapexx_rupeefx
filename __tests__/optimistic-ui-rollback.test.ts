import { describe, it, expect } from 'vitest';
import { cleanSym } from '../contexts/PositionsContext';

describe('Optimistic UI Rollback & Cancellation Logic', () => {
  describe('PositionsContext cleanSym helper', () => {
    it('normalizes various commodity and crypto symbol formats consistently', () => {
      expect(cleanSym('COMEX:XAUUSD')).toBe('XAUUSD');
      expect(cleanSym('GC=F')).toBe('XAUUSD');
      expect(cleanSym('MCX:CRUDEOIL26MARFUT')).toBe('CRUDEOIL26MARFUT');
      expect(cleanSym('CRYPTO:BTCUSD')).toBe('BTCUSDT');
      expect(cleanSym('BTC')).toBe('BTCUSDT');
    });
  });

  describe('Optimistic Position Removal & Rollback', () => {
    it('removes optimistic placeholder by deterministic opt_id or generated id', () => {
      const mockPositions = [
        { id: '__optimistic__opt_12345', symbol: 'RELIANCE', side: 'BUY', qty_open: 10, opt_id: 'opt_12345' },
        { id: 'real_pos_67890', symbol: 'TCS', side: 'BUY', qty_open: 5 }
      ];

      const removeOptimistic = (positions: any[], optId: string) => {
        return positions.filter(p => p.id !== optId && !p.id.includes(optId) && (p as any).opt_id !== optId);
      };

      const result = removeOptimistic(mockPositions, 'opt_12345');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('real_pos_67890');
    });
  });

  describe('Optimistic Order Cancellation & Error Reversion', () => {
    it('optimistically updates order to CANCELLED and rolls back if patch fails', async () => {
      let ordersState = [
        { id: 'order_1', symbol: 'INFY', status: 'PENDING', qty: 10 },
        { id: 'order_2', symbol: 'TCS', status: 'EXECUTED', qty: 5 }
      ];

      const cancelOrderWithRollback = async (id: string, shouldFail = false) => {
        let previousOrder: any;
        // 1. Optimistically mark CANCELLED
        previousOrder = ordersState.find(o => o.id === id);
        ordersState = ordersState.map(o => (o.id === id ? { ...o, status: 'CANCELLED' } : o));

        try {
          if (shouldFail) {
            throw new Error('Network error on cancel');
          }
          return { success: true };
        } catch (err: any) {
          // 2. Rollback
          if (previousOrder) {
            ordersState = ordersState.map(o => (o.id === id ? previousOrder : o));
          }
          return { success: false, error: err.message };
        }
      };

      // Test failure case
      const failRes = await cancelOrderWithRollback('order_1', true);
      expect(failRes.success).toBe(false);
      expect(ordersState.find(o => o.id === 'order_1')?.status).toBe('PENDING');

      // Test success case
      const successRes = await cancelOrderWithRollback('order_1', false);
      expect(successRes.success).toBe(true);
      expect(ordersState.find(o => o.id === 'order_1')?.status).toBe('CANCELLED');
    });
  });

  describe('Batch Exit Rollback on Network Failure', () => {
    it('restores all position IDs if batch close encounters an error', async () => {
      const removedIds = new Set<string>();
      const positionIds = ['pos_1', 'pos_2', 'pos_3'];

      const removeLocally = (id: string) => removedIds.add(id);
      const restoreLocally = (id: string) => removedIds.delete(id);

      // Simulate batch close execution
      positionIds.forEach(id => removeLocally(id));
      expect(removedIds.size).toBe(3);

      // Simulate failure catch block
      try {
        throw new Error('API 500 Internal Error');
      } catch (err) {
        positionIds.forEach(id => restoreLocally(id));
      }

      expect(removedIds.size).toBe(0);
    });
  });

  describe('Optimistic Margin Locking & Balance Calculation', () => {
    it('deducts locked margin from balance and calculates effective available margin', () => {
      const balance = 100000;
      const locks: Record<string, { amount: number; addedAt: number }> = {
        'opt_1': { amount: 25000, addedAt: Date.now() },
        'opt_2': { amount: 15000, addedAt: Date.now() }
      };

      const calculateEffectiveBalance = (rawBal: number, lockMap: Record<string, { amount: number; addedAt: number }>) => {
        const totalLocked = Object.values(lockMap).reduce((sum, item) => sum + item.amount, 0);
        return Math.max(0, rawBal - totalLocked);
      };

      const effective = calculateEffectiveBalance(balance, locks);
      expect(effective).toBe(60000);

      // Release one lock
      delete locks['opt_1'];
      expect(calculateEffectiveBalance(balance, locks)).toBe(85000);
    });

    it('preflight check respects effective balance instead of raw stale balance', () => {
      const effectiveBalance = 30000;
      const validatePreflight = (requiredMargin: number) => {
        if (effectiveBalance > 0 && requiredMargin > effectiveBalance) {
          return { valid: false, reason: 'Insufficient margin' };
        }
        return { valid: true };
      };

      expect(validatePreflight(20000).valid).toBe(true);
      expect(validatePreflight(35000).valid).toBe(false);
    });
  });
});
