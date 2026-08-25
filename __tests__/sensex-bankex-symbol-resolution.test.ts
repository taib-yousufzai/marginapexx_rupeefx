import { describe, it, expect } from 'vitest';
import { isForexSymbol, deriveExchange, buildSymbolInfo } from '../lib/datafeed/symbolResolver';

describe('SENSEX and BANKEX Symbol Resolution Audit', () => {
  it('correctly classifies SENSEX as non-FOREX and BSE exchange', () => {
    expect(isForexSymbol('SENSEX')).toBe(false);
    expect(isForexSymbol('BSE:SENSEX')).toBe(false);

    expect(deriveExchange('SENSEX')).toBe('BSE');
    expect(deriveExchange('BSE:SENSEX')).toBe('BSE');

    const info = buildSymbolInfo('SENSEX', 'Equity');
    expect(info.exchange).toBe('BSE');
    expect(info.type).toBe('stock');
    expect(info.ticker).toBe('BSE:SENSEX');
  });

  it('correctly classifies BANKEX as non-FOREX and BSE exchange', () => {
    expect(isForexSymbol('BANKEX')).toBe(false);
    expect(isForexSymbol('BSE:BANKEX')).toBe(false);

    expect(deriveExchange('BANKEX')).toBe('BSE');
    expect(deriveExchange('BSE:BANKEX')).toBe('BSE');

    const info = buildSymbolInfo('BANKEX', 'Equity');
    expect(info.exchange).toBe('BSE');
    expect(info.type).toBe('stock');
    expect(info.ticker).toBe('BSE:BANKEX');
  });

  it('correctly classifies BSE options/futures as BFO', () => {
    expect(deriveExchange('SENSEX26AUG74500CE')).toBe('BFO');
    expect(deriveExchange('SENSEX26AUGFUT')).toBe('BFO');
  });
});
