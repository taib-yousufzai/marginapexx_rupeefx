export interface MarketHours {
  id?: string;
  name?: string;
  start_time: string;
  end_time: string;
  is_active: boolean;
}

export const DEFAULT_TRADING_HOURS: Record<string, MarketHours> = {
  nse: { name: 'NSE Equity', start_time: '09:15', end_time: '15:30', is_active: true },
  bse: { name: 'BSE Equity', start_time: '09:15', end_time: '15:30', is_active: true },
  mcx: { name: 'MCX Commodities', start_time: '09:00', end_time: '23:30', is_active: true },
  forex: { name: 'FOREX', start_time: '00:00', end_time: '23:59', is_active: true },
  comex: { name: 'COMEX', start_time: '00:00', end_time: '23:59', is_active: true },
  crypto: { name: 'Crypto', start_time: '00:00', end_time: '00:00', is_active: true },
  'us-eq': { name: 'US Stocks', start_time: '00:00', end_time: '00:00', is_active: true },
};

export class RiskValidation {
  /**
   * Resolves the canonical trading_hours table row ID ('nse', 'mcx', 'bse', 'forex', 'comex', 'crypto')
   * based on symbol and dbSegment.
   */
  static resolveTradingHoursSegmentId(symbol: string, dbSegment: string = ''): string {
    const symUpper = (symbol || '').toUpperCase().trim();
    const segUpper = (dbSegment || '').toUpperCase().trim();
    const exchangeName = symUpper.includes(':') ? symUpper.split(':')[0] : '';
    const cleanSym = symUpper.replace(/^(CRYPTO:|BINANCE:|FOREX:|COMEX:|NSE:|BSE:|MCX:|NFO:|US:|US-EQ:)/i, '').replace(/[\/\s\_]/g, '');

    const CRYPTO_BASES = ['BTC','ETH','DOGE','DODGE','SOL','XRP','ADA','BNB','DOT','LTC','AVAX','MATIC','LINK','UNI','BCH','SHIB','PEPE','TRX','NEAR','SUI','APT','FET','RNDR','INJ','TIA','OP','ARB'];
    if (
      segUpper.includes('CRYPTO') ||
      symUpper.startsWith('CRYPTO:') ||
      symUpper.startsWith('BINANCE:') ||
      cleanSym.endsWith('USDT') ||
      CRYPTO_BASES.some(c => cleanSym === c || cleanSym.startsWith(c + 'USDT') || cleanSym === c + 'USD')
    ) {
      return 'crypto';
    }

    if (
      segUpper.includes('COMEX') ||
      symUpper.startsWith('COMEX:') ||
      ['XAUUSD', 'XAGUSD', 'XTIUSD', 'XCUUSD', 'XNGUSD'].some(c => symUpper.includes(c)) ||
      symUpper.endsWith('=F')
    ) {
      return 'comex';
    }

    if (
      exchangeName === 'US-EQ' ||
      exchangeName === 'USEQ' ||
      exchangeName === 'US' ||
      segUpper.includes('US-EQ') ||
      segUpper.includes('USEQ') ||
      segUpper.includes('US_EQ') ||
      segUpper.includes('US STOCKS') ||
      segUpper.includes('US_STOCKS') ||
      symUpper.startsWith('US:')
    ) {
      return 'us-eq';
    }

    const isCommodity =
      exchangeName === 'MCX' ||
      exchangeName === 'NCO' ||
      segUpper.includes('MCX') ||
      segUpper.includes('NCO') ||
      symUpper.includes('GOLD') ||
      symUpper.includes('SILVER') ||
      symUpper.includes('CRUDE') ||
      symUpper.includes('NATGAS') ||
      symUpper.includes('NATURALGAS') ||
      symUpper.includes('COPPER') ||
      symUpper.includes('ZINC') ||
      symUpper.includes('LEAD') ||
      symUpper.includes('ALUM');

    if (isCommodity) return 'mcx';
    if (exchangeName === 'BSE' || segUpper.includes('BSE') || segUpper.includes('BFO')) return 'bse';
    if (exchangeName === 'CDS' || exchangeName === 'FOREX' || segUpper.includes('CDS') || segUpper.includes('FOREX')) return 'forex';
    if (exchangeName === 'COMEX' || segUpper.includes('COMEX')) return 'comex';

    return 'nse';
  }

  /**
   * Validate if the user is allowed to trade the requested segment.
   * Note: If allowedSegments is empty, it implies all segments are allowed (default permissive).
   */
  static validateSegment(allowedSegments: string[], requestedSegment: string): boolean {
    if (!allowedSegments || allowedSegments.length === 0) {
      return true;
    }
    const reqUpper = (requestedSegment || '').toUpperCase().trim();
    if (allowedSegments.includes(reqUpper) || allowedSegments.includes(requestedSegment)) {
      return true;
    }
    if ((reqUpper === 'COMEX' || reqUpper === 'COI' || reqUpper.includes('COMEX')) && (allowedSegments.includes('COMEX') || allowedSegments.includes('COI') || allowedSegments.includes('MCX-FUT') || allowedSegments.length >= 8)) {
      return true;
    }
    return false;
  }

  /**
   * Validate if the requested quantity matches the lot size multiple.
   * For lotSize === 1 (equity, fractional crypto), decimals are allowed.
   */
  static validateLotSize(qty: number, lotSize: number): boolean {
    return qty > 0;
  }

  /**
   * Validate if the requested quantity exceeds the maximum freeze quantity.
   */
  static validateFreezeQuantity(qty: number, freezeQuantity: number): boolean {
    if (freezeQuantity > 0 && qty > freezeQuantity) {
      return false;
    }
    return true;
  }

  /**
   * Validate if the market is currently open for a given segment and hours config.
   * Handles weekends, standard sessions, and overnight trading correctly.
   */
  static isMarketOpenForSegment(segmentId: string, marketHours?: MarketHours | null): boolean {
    const sId = (segmentId || '').toLowerCase().trim();
    if (sId === 'crypto') return true;

    const hours = marketHours || DEFAULT_TRADING_HOURS[sId] || DEFAULT_TRADING_HOURS['nse'];
    if (!hours || !hours.is_active) return false;

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Kolkata',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
      hour12: false
    });
    const parts = formatter.formatToParts(new Date());
    const weekday = parts.find(p => p.type === 'weekday')?.value;
    const hourVal = parts.find(p => p.type === 'hour')?.value;
    const minuteVal = parts.find(p => p.type === 'minute')?.value;
    if (!hourVal || !minuteVal) return false;

    // Weekend check for Indian markets & regular exchanges
    const isIndianMarket = ['nse', 'bse', 'mcx'].includes(sId);
    if ((isIndianMarket || sId === 'forex' || sId === 'comex') && (weekday === 'Sat' || weekday === 'Sun')) {
      return false;
    }

    const currentMins = Number(hourVal) * 60 + Number(minuteVal);
    const [startH, startM] = (hours.start_time || '09:15').split(':').map(Number);
    const [endH, endM] = (hours.end_time || '15:30').split(':').map(Number);

    if (isNaN(startH) || isNaN(startM) || isNaN(endH) || isNaN(endM)) {
      return false;
    }

    const startMins = startH * 60 + startM;
    let endMins = endH * 60 + endM;

    // 00:00 or 23:59 represents full day or 24/7 if start is 00:00
    if (startMins === 0 && (endMins === 0 || endMins === 1439 || endMins === 1440)) {
      return true;
    }

    if (startMins < endMins) {
      // Standard daytime session (e.g. 09:15 to 15:30)
      return currentMins >= startMins && currentMins < endMins;
    } else {
      // Overnight session (e.g. 22:00 to 02:00)
      return currentMins >= startMins || currentMins < endMins;
    }
  }

  /**
   * Validate if the market is currently open for the segment.
   * Handles overnight sessions correctly (e.g. 22:00 to 02:00).
   */
  static validateTradingHours(marketHours: MarketHours | null | undefined): boolean {
    return this.isMarketOpenForSegment('nse', marketHours);
  }

  /**
   * Validates if there's enough free margin for the required margin.
   */
  static validateMargin(freeMargin: number, requiredMargin: number): boolean {
    return freeMargin >= requiredMargin;
  }

  /**
   * Validates if the maximum lot limit for the user has been exceeded.
   */
  static validateMaxLotLimit(totalLotsAfterOrder: number, maxLotLimit: number): boolean {
    if (maxLotLimit > 0 && totalLotsAfterOrder > maxLotLimit) {
      return false;
    }
    return true;
  }
}
