import { describe, it, expect } from 'vitest';
import { sanitizeOrderInfo, isUserVisibleInfo } from '../lib/trading/orderSanitizer';

describe('orderSanitizer', () => {
  it('strips full 8-group UUIDs', () => {
    const raw = '0b01cd93-1878-4c86-a17f-6af9cf5d9027';
    expect(sanitizeOrderInfo(raw)).toBeNull();
    expect(isUserVisibleInfo(raw)).toBe(false);
  });

  it('strips shortened 7-group UUIDs', () => {
    const raw = '0b01cd9-1878-4c86-a17f-6af9cf5d9027';
    expect(sanitizeOrderInfo(raw)).toBeNull();
    expect(isUserVisibleInfo(raw)).toBe(false);
  });

  it('strips UUIDs with modification suffixes containing spaces', () => {
    const raw = '0b01cd9-1878-4c86-a17f-6af9cf5d9027 (Modified to SLM)';
    expect(sanitizeOrderInfo(raw)).toBeNull();
    expect(isUserVisibleInfo(raw)).toBe(false);
  });

  it('strips system modification notes without UUIDs', () => {
    const raw = 'Modified to GTT';
    expect(sanitizeOrderInfo(raw)).toBeNull();
    expect(isUserVisibleInfo(raw)).toBe(false);
  });

  it('strips FIFO routing tags', () => {
    expect(sanitizeOrderInfo('FIFO_EXIT')).toBeNull();
    expect(sanitizeOrderInfo('FIFO_PARTIAL_CLOSE')).toBeNull();
  });

  it('strips system exit tags', () => {
    expect(sanitizeOrderInfo('Exit - USER')).toBeNull();
    expect(sanitizeOrderInfo('Exit - SYSTEM')).toBeNull();
    expect(sanitizeOrderInfo('Exit - BROKER')).toBeNull();
  });

  it('strips virtual order IDs', () => {
    expect(sanitizeOrderInfo('pos-sl-0b01cd9-1878')).toBeNull();
    expect(sanitizeOrderInfo('pos-target-12345')).toBeNull();
  });

  it('preserves valid human rejection messages', () => {
    const msg1 = 'Insufficient margin available';
    expect(sanitizeOrderInfo(msg1)).toBe(msg1);
    expect(isUserVisibleInfo(msg1)).toBe(true);

    const msg2 = 'Trigger price 150.00 is out of allowed 5% execution band';
    expect(sanitizeOrderInfo(msg2)).toBe(msg2);
    expect(isUserVisibleInfo(msg2)).toBe(true);

    const msg3 = 'Order cancelled by user';
    expect(sanitizeOrderInfo(msg3)).toBe(msg3);
    expect(isUserVisibleInfo(msg3)).toBe(true);
  });

  it('handles null, undefined, and empty whitespace strings gracefully', () => {
    expect(sanitizeOrderInfo(null)).toBeNull();
    expect(sanitizeOrderInfo(undefined)).toBeNull();
    expect(sanitizeOrderInfo('')).toBeNull();
    expect(sanitizeOrderInfo('   ')).toBeNull();
    expect(isUserVisibleInfo(null)).toBe(false);
  });
});
