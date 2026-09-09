type Bar = any;
type DatafeedConfiguration = any;
type DatafeedErrorCallback = any;
type HistoryCallback = any;
type IBasicDataFeed = any;
type LibrarySymbolInfo = any;
type OnReadyCallback = any;
type PeriodParams = any;
type ResolveCallback = any;
type ResolutionString = any;
type SubscribeBarsCallback = any;
import { fetchBars } from './historyProvider';
import { RealtimeProvider } from './realtimeProvider';
import { buildSymbolInfo, getCanonicalSymbol } from './symbolResolver';

/**
 * TradingView `IBasicDataFeed` implementation.
 */
export class Datafeed implements IBasicDataFeed {
  private readonly realtimeProvider: RealtimeProvider;
  private readonly lastBarCache = new Map<string, Bar>();
  private firstBarFired = false;
  private firstRealtimeTickLogged = false;
  private getBarsCallNum = 0;
  private loadId: string = 'default';
  private loadStartTime: number = performance.now();
  onFirstBar?: (lastClose: number, prevClose: number | null) => void;
  onProgress?: (event: string) => void;
  onError?: (errorMsg: string) => void;

  constructor(private segment: string, loadId?: string, loadStartTime?: number) {
    this.realtimeProvider = new RealtimeProvider();
    if (loadId) this.loadId = loadId;
    if (loadStartTime) this.loadStartTime = loadStartTime;
  }

  setSegment(segment: string) {
    this.segment = segment;
    this.firstBarFired = false;
    this.firstRealtimeTickLogged = false;
  }

  setLoadId(loadId: string, startTime?: number) {
    this.loadId = loadId;
    this.loadStartTime = startTime ?? performance.now();
    this.getBarsCallNum = 0;
    this.firstBarFired = false;
    this.firstRealtimeTickLogged = false;
    this.lastBarCache.clear();
  }

  // ---------------------------------------------------------------------------
  // IExternalDatafeed
  // ---------------------------------------------------------------------------

  onReady(callback: OnReadyCallback): void {
    const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} event=DATAFEED_ON_READY elapsed=${elapsed}ms`);
    this.onProgress?.('onReady');
    setTimeout(() => {
      callback({
        supported_resolutions: ['1', '2', '3', '5', '10', '15', '30', '60', 'D'] as ResolutionString[],
        supports_time: true,
      } satisfies DatafeedConfiguration);
    }, 0);
  }

  // ---------------------------------------------------------------------------
  // IDatafeedChartApi
  // ---------------------------------------------------------------------------

  resolveSymbol(
    symbolName: string,
    onResolve: ResolveCallback,
    _onError: DatafeedErrorCallback,
  ): void {
    const start = performance.now();
    const elapsed = (start - this.loadStartTime).toFixed(1);
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${symbolName} event=RESOLVE_SYMBOL_START elapsed=${elapsed}ms`);
    this.onProgress?.('resolveSymbol');
    const info = buildSymbolInfo(symbolName, this.segment);
    onResolve(info);
    const endElapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${symbolName} event=RESOLVE_SYMBOL_END elapsed=${endElapsed}ms`);
  }

  async getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    periodParams: PeriodParams,
    onResult: HistoryCallback,
    onError: DatafeedErrorCallback,
  ): Promise<void> {
    this.getBarsCallNum++;
    const currentCallNum = this.getBarsCallNum;
    const canonicalSymbol = getCanonicalSymbol(symbolInfo);
    const start = performance.now();
    const startElapsed = (start - this.loadStartTime).toFixed(1);
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=GET_BARS_START elapsed=${startElapsed}ms callNum=${currentCallNum} firstDataRequest=${periodParams.firstDataRequest}`);
    this.onProgress?.(`getBars_start_${currentCallNum}`);

    try {
      const { bars, noData } = await fetchBars(symbolInfo, resolution, periodParams, this.segment, this.loadId, currentCallNum, this.loadStartTime);
      const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=GET_BARS_END elapsed=${elapsed}ms callNum=${currentCallNum} barCount=${bars.length} noData=${noData}`);
      this.onProgress?.(`getBars_end_${currentCallNum}`);
      
      if (bars.length > 0 && (periodParams.firstDataRequest === undefined || periodParams.firstDataRequest)) {
        const firstBar = bars[0] as Bar;
        const lastBar = bars[bars.length - 1] as Bar;
        
        const cacheKey = `${canonicalSymbol}:${resolution}`;
        this.lastBarCache.set(cacheKey, lastBar);

        console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=FIRST_HISTORICAL_BAR elapsed=${elapsed}ms time=${firstBar.time} close=${firstBar.close}`);
        console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=LAST_BAR_ESTABLISHED elapsed=${elapsed}ms time=${lastBar.time} close=${lastBar.close}`);

        this.realtimeProvider.setLastBar(canonicalSymbol, resolution, lastBar);

        if (!this.firstBarFired) {
          this.firstBarFired = true;
          const prevClose = bars.length > 1 ? (bars[bars.length - 2] as Bar).close : null;
          console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=FIRST_VISIBLE_CANDLE_RENDERED elapsed=${elapsed}ms lastClose=${lastBar.close}`);
          this.onFirstBar?.(lastBar.close, prevClose);
        }
      }
      onResult(bars, { noData });
    } catch (err) {
      const errElapsed = (performance.now() - this.loadStartTime).toFixed(1);
      const errMessage = (err as Error).message || 'Failed to fetch historical bars';
      console.error(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=GET_BARS_ERROR elapsed=${errElapsed}ms callNum=${currentCallNum}`, err);
      this.onError?.(errMessage);
      onError(errMessage);
    }
  }

  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: ResolutionString,
    onTick: SubscribeBarsCallback,
    listenerGuid: string,
    _onResetCacheNeededCallback: () => void,
  ): void {
    const canonicalSymbol = getCanonicalSymbol(symbolInfo);
    const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} symbol=${canonicalSymbol} resolution=${resolution} event=SUBSCRIBE_BARS_START elapsed=${elapsed}ms listenerGuid=${listenerGuid}`);
    this.onProgress?.('subscribeBars');

    const cacheKey = `${canonicalSymbol}:${resolution}`;
    const lastBar = this.lastBarCache.get(cacheKey) || null;

    this.realtimeProvider.subscribe(listenerGuid, {
      symbol: canonicalSymbol,
      resolution,
      callback: (bar: Bar) => {
        onTick(bar);
      },
      lastBar,
      loadId: this.loadId,
      loadStartTime: this.loadStartTime,
    });
  }

  unsubscribeBars(listenerGuid: string): void {
    const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${this.loadId} event=UNSUBSCRIBE_BARS elapsed=${elapsed}ms listenerGuid=${listenerGuid}`);
    this.realtimeProvider.unsubscribe(listenerGuid);
  }

  searchSymbols(
    userInput: string,
    _exchange: string,
    _symbolType: string,
    onResult: (result: any[]) => void,
  ): void {
    if (!userInput || !userInput.trim()) {
      onResult([]);
      return;
    }
    const q = userInput.trim();
    fetch(`/api/market/instruments/search?q=${encodeURIComponent(q)}&tab=All`)
      .then(res => res.json())
      .then((items: any[]) => {
        if (!Array.isArray(items)) {
          onResult([]);
          return;
        }
        const results = items.slice(0, 30).map(item => ({
          symbol: item.symbol,
          full_name: item.kiteSymbol || item.symbol,
          description: item.name || item.symbol,
          exchange: item.segment || 'NSE',
          ticker: item.kiteSymbol || item.symbol,
          type: (item.segment || '').toLowerCase().includes('option')
            ? 'options'
            : (item.segment || '').toLowerCase().includes('future')
            ? 'futures'
            : 'stock',
        }));
        onResult(results);
      })
      .catch(() => {
        onResult([]);
      });
  }

  getServerTime(callback: (serverTime: number) => void): void {
    callback(Math.floor(Date.now() / 1000));
  }

  updateLive(symbol: string, lastPrice: number, nowMs: number, volume?: number) {
    const canonicalSymbol = getCanonicalSymbol(symbol);
    if (!this.firstRealtimeTickLogged) {
      this.firstRealtimeTickLogged = true;
      const elapsed = (performance.now() - this.loadStartTime).toFixed(1);
      console.log(`[CHART TRACE ${this.loadId}] +${elapsed}ms [11] First realtime tick received: symbol=${canonicalSymbol}, price=${lastPrice}`);
    }
    this.realtimeProvider.update(canonicalSymbol, lastPrice, nowMs, volume);
  }
}

