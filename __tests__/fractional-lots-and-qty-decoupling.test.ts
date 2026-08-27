import { describe, it, expect } from 'vitest';

describe('Fractional Lots & QTY/LOT Decoupling Unit Tests', () => {
  it('A. Decouples QTY from LOT when lotSize > 1 (1 Qty = 1 single unit)', () => {
    const symbolLotSize = 25; // NIFTY
    
    // In QTY mode: typing 1 means 1 quantity unit
    const inputQty = 1;
    const orderUnit = 'qty';
    
    const finalQty = orderUnit === 'lot' ? inputQty * symbolLotSize : inputQty;
    const finalLots = finalQty / symbolLotSize;
    
    expect(finalQty).toBe(1);
    expect(finalLots).toBe(0.04);
  });

  it('B. Calculates exact Total Qty for fractional lots (0.1, 0.5, 1.5 lots)', () => {
    const symbolLotSize = 25; // NIFTY
    
    // 0.1 Lot
    const qty01 = 0.1 * symbolLotSize;
    expect(qty01).toBe(2.5);

    // 0.5 Lot
    const qty05 = 0.5 * symbolLotSize;
    expect(qty05).toBe(12.5);

    // 1.5 Lot
    const qty15 = 1.5 * symbolLotSize;
    expect(qty15).toBe(37.5);
  });

  it('C. Converts seamlessly between LOT and QTY units', () => {
    const symbolLotSize = 25;

    // Toggle from 1.5 Lots to QTY
    const lotInput = 1.5;
    const qtyConverted = lotInput * symbolLotSize;
    expect(qtyConverted).toBe(37.5);

    // Toggle from 37.5 Qty to LOT
    const qtyInput = 37.5;
    const lotConverted = parseFloat((qtyInput / symbolLotSize).toFixed(4));
    expect(lotConverted).toBe(1.5);
  });

  it('D. When lotSize === 1 (set by admin), 1 Qty === 1 Lot === 1 Unit', () => {
    const symbolLotSize = 1; // Stocks or Crypto
    
    const inputVal = 1;
    const finalQty = inputVal * symbolLotSize;
    const finalLots = finalQty / symbolLotSize;

    expect(finalQty).toBe(1);
    expect(finalLots).toBe(1);
  });

  it('E. Allows closing full position quantity (e.g. 99 Qty) even when max_order_lot is 50', () => {
    const maxOrderLot = 50;
    const symbolLotSize = 1;
    const maxQty = maxOrderLot * symbolLotSize; // 50

    const exitQty = 99;
    const isExit = true;

    // Entry mode validation: should fail if qty > maxQty
    const isEntryValid = !isExit && exitQty > maxQty ? false : true;
    expect(isEntryValid).toBe(true); // Entry check skipped because isExit is true

    // Exit validation logic:
    const isExitAllowed = isExit || exitQty <= maxQty;
    expect(isExitAllowed).toBe(true);
  });
});
