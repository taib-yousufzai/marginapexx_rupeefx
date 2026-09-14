import { describe, it, expect, vi, beforeEach } from 'vitest';
import { POST } from '../route';

// Mock dependencies
vi.mock('../../../../_auth', () => {
  const mockRpc = vi.fn();
  const mockFrom = vi.fn();

  return {
    requireAdmin: vi.fn().mockResolvedValue({
      adminClient: {
        rpc: mockRpc,
        from: mockFrom,
      }
    }),
  };
});

vi.mock('@/lib/trading/BrokerageCalculator', () => ({
  calculateCarryBrokerage: vi.fn().mockReturnValue(0),
}));

global.fetch = vi.fn();

describe('Admin Square-Off POST /api/admin/positions/[id]/sqoff', () => {
  let mockRpc: any;
  let mockFrom: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { requireAdmin } = await import('../../../../_auth');
    const authResult = (await requireAdmin(null as any)) as any;
    mockRpc = authResult.adminClient.rpc;
    mockFrom = authResult.adminClient.from;

    mockFrom.mockImplementation((table: string) => {
      const qb: any = {
        select: vi.fn(() => qb),
        eq: vi.fn(() => qb),
        single: vi.fn(() => qb),
        maybeSingle: vi.fn(() => qb),
      };
      
      qb.then = function(resolve: any) {
        if (table === 'positions') {
          resolve({
            data: {
              id: 'pos-123',
              user_id: 'user-456',
              symbol: 'NIFTY',
              side: 'BUY',
              settlement: 'NSE',
              qty_open: 50,
              entry_price: 100,
              ltp: 110,
              product_type: 'INTRADAY',
            },
            error: null,
          });
        } else if (table === 'segment_settings') {
          resolve({
            data: {
              exit_buffer: 0.17,
              carry_commission_type: 'Fixed',
              carry_commission_value: 0,
              commission_type: 'Fixed',
              commission_value: 0,
            },
            error: null,
          });
        } else {
          resolve({ data: null, error: null });
        }
      };
      
      return qb;
    });

    mockRpc.mockResolvedValue({ data: 500, error: null });

    (global.fetch as any).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          'NSE:NIFTY': {
            bid: 110,
            ask: 110.5,
          }
        }
      })
    });
  });

  it('should call close_position RPC with p_closed_by: "ADMIN"', async () => {
    const req = new Request('http://localhost/api/admin/positions/pos-123/sqoff', {
      method: 'POST',
    });
    
    const res = await POST(req, { params: Promise.resolve({ id: 'pos-123' }) });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    // Verify RPC call arguments
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const rpcArgs = mockRpc.mock.calls[0];
    expect(rpcArgs[0]).toBe('close_position_v2');
    expect(rpcArgs[1]).toMatchObject({
      p_position_id: 'pos-123',
      p_close_qty: 50,
      p_close_price: 109.81, // 110 * (1 - 0.17/100) = 109.81
      p_closed_by: 'ADMIN',
    });
  });
});
