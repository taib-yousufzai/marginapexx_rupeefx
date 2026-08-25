import { describe, it, expect } from 'vitest';

function inferKiteSymbol(symbol: string): string {
  let k = symbol;
  if (!k.includes(':')) {
    const cleanSym = k.toUpperCase();
    const isOption = (cleanSym.endsWith('CE') || cleanSym.endsWith('PE')) && /\d/.test(cleanSym);
    const isFut = cleanSym.endsWith('FUT') || cleanSym.includes('FUTURES');
    let prefix = 'NSE';
    if (cleanSym.includes('SENSEX') || cleanSym.includes('BANKEX')) {
      prefix = 'BFO';
    } else if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'NATGAS', 'MCX', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL'].some(x => cleanSym.includes(x))) {
      prefix = 'MCX';
    } else if (isOption || isFut) {
      prefix = 'NFO';
    }
    k = `${prefix}:${cleanSym}`;
  }
  return k;
}

describe('Re-Trade Symbol Resolution & Exchange Prefix Inference', () => {
  it('correctly infers MCX prefix for commodity futures and option re-trades', () => {
    expect(inferKiteSymbol('GOLD26AUG16400PE')).toBe('MCX:GOLD26AUG16400PE');
    expect(inferKiteSymbol('GOLD26AUGFUT')).toBe('MCX:GOLD26AUGFUT');
    expect(inferKiteSymbol('CRUDEOIL26AUGFUT')).toBe('MCX:CRUDEOIL26AUGFUT');
    expect(inferKiteSymbol('NATGAS26AUG210CE')).toBe('MCX:NATGAS26AUG210CE');
  });

  it('correctly infers NFO prefix for index/stock options and futures', () => {
    expect(inferKiteSymbol('NIFTY26AUG24500CE')).toBe('NFO:NIFTY26AUG24500CE');
    expect(inferKiteSymbol('BANKNIFTY26AUGFUT')).toBe('NFO:BANKNIFTY26AUGFUT');
    expect(inferKiteSymbol('RELIANCE26AUG1400CE')).toBe('NFO:RELIANCE26AUG1400CE');
  });

  it('correctly infers BFO prefix for BSE options and futures', () => {
    expect(inferKiteSymbol('SENSEX26AUG80000CE')).toBe('BFO:SENSEX26AUG80000CE');
  });

  it('correctly infers NSE prefix for cash equities', () => {
    expect(inferKiteSymbol('RELIANCE')).toBe('NSE:RELIANCE');
    expect(inferKiteSymbol('TCS')).toBe('NSE:TCS');
  });

  it('preserves existing exchange prefix intact', () => {
    expect(inferKiteSymbol('MCX:GOLD26AUG16400PE')).toBe('MCX:GOLD26AUG16400PE');
    expect(inferKiteSymbol('NFO:NIFTY26AUG24500CE')).toBe('NFO:NIFTY26AUG24500CE');
    expect(inferKiteSymbol('CDS:GBPUSD')).toBe('CDS:GBPUSD');
  });
});
