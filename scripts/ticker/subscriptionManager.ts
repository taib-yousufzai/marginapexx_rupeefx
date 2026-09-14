import { getAdminClient } from '../../lib/adminClient.ts';
import pino from 'pino';
import type { WebSocketGateway } from './gateway.ts';

const logger = pino({ name: 'ticker-subscription-manager' });

export interface InstrumentMapping {
  token: number;
  symbolKey: string; // e.g. "NSE:INFY"
}

export class SubscriptionManager {
  private activeTokens: Set<number> = new Set();
  private tokenToSymbol: Map<number, string> = new Map();
  private symbolToToken: Map<string, number> = new Map();
  private gateway: WebSocketGateway | null = null;

  /**
   * Links the WebSocket gateway so dynamic client subscriptions
   * (e.g. option chain strikes) are included in Kite subscriptions.
   */
  public setGateway(gateway: WebSocketGateway) {
    this.gateway = gateway;
  }

  /**
   * Fetches active instruments from watchlists, open positions, and pending orders,
   * then maps them to their respective instrument_tokens from the database.
   */
  public async getActiveInstruments(): Promise<InstrumentMapping[]> {
    try {
      const admin = getAdminClient();
      const symbolsToResolve = new Set<string>([
        // Always subscribe to core index and default instruments for home/overview dashboards
        'NSE:NIFTY 50',
        'BSE:SENSEX',
        'NSE:NIFTY BANK',
        'CDS:USDINR26AUGFUT',
        'MCX:CRUDEOIL26SEPFUT',
        'MCX:GOLD26OCTFUT',
        'MCX:GOLD',
        'MCX:SILVER26SEPFUT',
        'MCX:SILVER',
        'MCX:NATURALGAS26AUGFUT',
        'MCX:CRUDEOIL',
        'MCX:NATURALGAS',
        'NSE:NIFTY FIN SERVICE',
        'NSE:NIFTY MID SELECT',
        'BSE:BANKEX',
      ]);

      // 1. Fetch symbols from watchlists
      const { data: watchlists, error: wlError } = await admin
        .from('watchlists')
        .select('symbol');
      
      if (wlError) {
        logger.error({ err: wlError }, 'Error fetching watchlists');
      } else if (watchlists) {
        watchlists.forEach(w => {
          if (w.symbol) symbolsToResolve.add(w.symbol.trim());
        });
      }

      // 2. Fetch symbols from open positions
      const { data: openPositions, error: posError } = await admin
        .from('positions')
        .select('symbol, settlement')
        .eq('status', 'open');

      if (posError) {
        logger.error({ err: posError }, 'Error fetching open positions');
      } else if (openPositions) {
        openPositions.forEach(p => {
          if (!p.symbol) return;
          const sym = p.symbol.trim();
          if (sym.includes(':')) {
            symbolsToResolve.add(sym);
          } else {
            let exchange = 'NSE';
            if (p.settlement) {
              const s = p.settlement.toUpperCase();
              if (s.includes('MCX')) exchange = 'MCX';
              else if (s.includes('NCO') || s.includes('NSE COMMODITY')) exchange = 'NCO';
              else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
              else if (s.includes('BSE') || s.includes('BFO')) exchange = 'BFO';
              else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
              if (sym.startsWith('SENSEX') || sym.startsWith('BANKEX')) exchange = 'BFO';
            }
            symbolsToResolve.add(`${exchange}:${sym}`);
          }
        });
      }

      // 3. Fetch symbols from pending orders
      const { data: pendingOrders, error: orderError } = await admin
        .from('orders')
        .select('symbol, kite_instrument, segment')
        .eq('status', 'PENDING');

      if (orderError) {
        logger.error({ err: orderError }, 'Error fetching pending orders');
      } else if (pendingOrders) {
        pendingOrders.forEach(o => {
          if (o.kite_instrument) {
            symbolsToResolve.add(o.kite_instrument.trim());
          } else if (o.symbol) {
            const sym = o.symbol.trim();
            if (sym.includes(':')) {
              symbolsToResolve.add(sym);
            } else {
              let exchange = 'NSE';
              if (o.segment) {
                const s = o.segment.toUpperCase();
                if (s.includes('MCX')) exchange = 'MCX';
                else if (s.includes('NCO') || s.includes('NSE COMMODITY')) exchange = 'NCO';
                else if (s.includes('CDS') || s.includes('FOREX')) exchange = 'CDS';
                else if (s.includes('BSE') || s.includes('BFO')) exchange = 'BFO';
                else if (s.includes('OPT') || s.includes('FUT') || s.includes('NFO')) exchange = 'NFO';
                if (sym.startsWith('SENSEX') || sym.startsWith('BANKEX')) exchange = 'BFO';
              }
              symbolsToResolve.add(`${exchange}:${sym}`);
            }
          }
        });
      }

      // 4. Merge symbols dynamically requested by frontend WebSocket clients
      //    (e.g. Option Chain strikes that aren't in any watchlist/position)
      if (this.gateway) {
        const clientSymbols = this.gateway.getActiveSubscribedSymbols();
        for (const sym of clientSymbols) {
          if (sym && sym.trim()) {
            symbolsToResolve.add(sym.trim());
          }
        }
      }

      if (symbolsToResolve.size === 0) {
        return [];
      }

      // 4. Resolve symbols to instrument_tokens using instruments table
      // Split into prefixed (contains ':') and raw symbols (does not contain ':')
      const prefixedSymbols: string[] = [];
      const rawSymbols: string[] = [];
      for (const sym of symbolsToResolve) {
        if (sym.includes(':')) {
          prefixedSymbols.push(sym);
        } else {
          rawSymbols.push(sym);
        }
      }

      let resolvedInstruments: any[] = [];
      
      if (prefixedSymbols.length > 0) {
        const { data, error: resolveError } = await admin
          .from('instruments')
          .select('id, instrument_token')
          .in('id', prefixedSymbols);

        if (resolveError) {
          logger.error({ err: resolveError }, 'Error resolving prefixed instrument tokens');
        } else if (data) {
          resolvedInstruments.push(...data);
        }
      }

      if (rawSymbols.length > 0) {
        const { data, error: resolveError } = await admin
          .from('instruments')
          .select('id, instrument_token')
          .in('tradingsymbol', rawSymbols);

        if (resolveError) {
          logger.error({ err: resolveError }, 'Error resolving raw instrument tokens');
        } else if (data) {
          resolvedInstruments.push(...data);
        }
      }

      const mappings: InstrumentMapping[] = [];
      this.tokenToSymbol.clear();
      this.symbolToToken.clear();

      if (resolvedInstruments) {
        // Sort so MCX exchange rows process after NCO rows, ensuring MCX takes precedence in maps
        resolvedInstruments.sort((a, b) => {
          if (a.id?.startsWith('MCX:') && !b.id?.startsWith('MCX:')) return 1;
          if (!a.id?.startsWith('MCX:') && b.id?.startsWith('MCX:')) return -1;
          return 0;
        });

        resolvedInstruments.forEach(row => {
          const token = Number(row.instrument_token);
          const symbolKey = row.id;
          
          mappings.push({ token, symbolKey });
          this.tokenToSymbol.set(token, symbolKey);
          this.symbolToToken.set(symbolKey, token);

          if (symbolKey.includes('SILVER') || symbolKey.includes('GOLD')) {
            logger.info({ symbolKey, token, tradingsymbol: row.tradingsymbol }, '[MCX DIAGNOSTIC] Mapped instrument token');
          }
        });
      }

      logger.info({ count: mappings.length }, 'Successfully resolved active instruments to tokens');
      return mappings;
    } catch (err) {
      logger.error({ err }, 'Unexpected error in subscription manager');
      return [];
    }
  }

  /**
   * Translates an instrument_token number to its symbol key (e.g. 256001 -> "NSE:NIFTY 50")
   */
  public getSymbolKey(token: number): string | undefined {
    return this.tokenToSymbol.get(token);
  }

  /**
   * Compares the newly active tokens with currently subscribed tokens, returning the lists to subscribe and unsubscribe.
   */
  public calculateSubscriptionDelta(newTokens: number[]): { toSubscribe: number[]; toUnsubscribe: number[] } {
    const newTokensSet = new Set(newTokens);
    const toSubscribe: number[] = [];
    const toUnsubscribe: number[] = [];

    // Tokens to subscribe: in newTokens but not in activeTokens
    for (const token of newTokens) {
      if (!this.activeTokens.has(token)) {
        toSubscribe.push(token);
      }
    }

    // Tokens to unsubscribe: in activeTokens but not in newTokens
    for (const token of this.activeTokens) {
      if (!newTokensSet.has(token)) {
        toUnsubscribe.push(token);
      }
    }

    // Update internal state
    this.activeTokens = newTokensSet;

    return { toSubscribe, toUnsubscribe };
  }

  public getSubscribedTokens(): number[] {
    return Array.from(this.activeTokens);
  }

  public setupRealtime(onUpdate: () => void) {
    const admin = getAdminClient();
    admin
      .channel('ticker-subscription-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'watchlists' }, () => {
        logger.info('Watchlist change detected via Realtime. Re-syncing subscriptions...');
        onUpdate();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'positions' }, () => {
        logger.info('Position change detected via Realtime. Re-syncing subscriptions...');
        onUpdate();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => {
        logger.info('Order change detected via Realtime. Re-syncing subscriptions...');
        onUpdate();
      })
      .subscribe((status) => {
        logger.info({ status }, 'Supabase Realtime subscription status for ticker sync');
      });
  }
}
