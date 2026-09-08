/**
 * Aggregates position rows for a single user.
 *
 * Returns net_pnl, brokerage, pnl_bkg, and settlement.
 * pnl_bkg is ALWAYS computed as net_pnl + brokerage (Property 13).
 */
export function aggregatePositions(
  positions: Array<{
    pnl: number | null;
    brokerage: number | null;
    settlement_amount?: number | null;
    settlement?: string | number | null;
  }>,
): { net_pnl: number; brokerage: number; pnl_bkg: number; settlement: number } {
  let net_pnl = 0;
  let brokerage = 0;
  let settlement = 0;

  for (const pos of positions) {
    net_pnl += Number(pos.pnl ?? 0);
    brokerage += Number(pos.brokerage ?? 0);
    const posSettlement = pos.settlement_amount ?? (typeof pos.settlement === 'number' ? pos.settlement : 0);
    settlement += Number(posSettlement);
  }

  return {
    net_pnl,
    brokerage,
    pnl_bkg: net_pnl + brokerage,
    settlement,
  };
}
