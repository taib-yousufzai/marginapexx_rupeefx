import React, { useEffect, useRef, useState } from 'react';
// import type { IChartingLibraryWidget } from '@/public/charting_library/charting_library';
import { Datafeed } from '@/lib/datafeed/Datafeed';
import { toUdfResolution, CHART_TYPE_MAP } from '@/lib/datafeed/resolutionUtils';
import { Candle, Timeframe } from '@/components/chart/types';
import AnimatedLoader from '@/components/AnimatedLoader';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { getSavedTheme } from '@/lib/theme';
import { formatShortName } from '@/lib/datafeed/symbolResolver';

// ─── Supporting types ────────────────────────────────────────────────────────

interface PendingChanges {
  symbol?: string;
  timeframe?: Timeframe;
  chartType?: 'candle' | 'area' | 'bar' | 'baseline';
  theme?: 'dark' | 'light';
  indicators?: boolean;
}

type IndicatorKey = 'sma' | 'ema' | 'rsi' | 'macd';
type IndicatorEntityIds = Record<IndicatorKey, string | null>;

// ─── Props interface (must match TradingChart.tsx exactly) ───────────────────

interface ChartContainerProps {
  symbol: string;
  segment: string;
  timeframe: Timeframe;
  chartType: 'candle' | 'area' | 'bar' | 'baseline';
  candles: Candle[];
  liveQuote?: any;
  loading: boolean;
  error: string | null;
  loadId?: string;
  /** Called once when the TV widget's first getBars response arrives with bars */
  onFirstBar?: (lastClose: number, prevClose: number | null) => void;
}

// Global counters for React lifecycle tracking across component instances
let globalMountCount = 0;
let globalUnmountCount = 0;
let globalWidgetCreateCount = 0;
let globalWidgetDestroyCount = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getIsDark(): boolean {
  if (typeof document === 'undefined') return false;
  const saved = getSavedTheme();
  if (saved === 'dark' || saved === 'black' || saved === 'blue') return true;
  if (saved === 'light') return false;
  return (
    document.body.classList.contains('dark') ||
    document.body.classList.contains('black') ||
    document.body.classList.contains('blue') ||
    document.documentElement.classList.contains('dark') ||
    document.documentElement.classList.contains('black') ||
    document.documentElement.classList.contains('blue')
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function ChartContainer({
  symbol,
  segment,
  timeframe,
  chartType,
  candles,
  liveQuote,
  loading,
  error,
  loadId: propLoadId,
  onFirstBar,
}: ChartContainerProps) {
  const activeLoadId = propLoadId || 'def';
  const loadStartTimeRef = useRef(performance.now());
  // ── Refs ──────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const tvWidgetRef = useRef<any | null>(null);
  const datafeedRef = useRef<Datafeed | null>(null);
  const isReadyRef = useRef(false);
  const pendingRef = useRef<PendingChanges>({});
  const initTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onFirstBarRef = useRef(onFirstBar);
  // Keep the callback ref current without re-running the init effect
  useEffect(() => { onFirstBarRef.current = onFirstBar; }, [onFirstBar]);

  // Update datafeed loadId when propLoadId changes
  useEffect(() => {
    if (datafeedRef.current && propLoadId) {
      datafeedRef.current.setLoadId(propLoadId);
    }
  }, [propLoadId]);

  // ── State (drives overlay rendering only) ─────────────────────────────────
  const [chartStatus, setChartStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [chartError, setChartError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(getIsDark);

  // ── Native Toolbar Listeners ─────────────────────────────────────────────
  useEffect(() => {
    const handleShowIndicators = () => {
      if (isReadyRef.current && tvWidgetRef.current) {
        tvWidgetRef.current.chart().executeActionById('insertIndicator');
      }
    };
    const handleToggleDrawings = () => {
      if (isReadyRef.current && tvWidgetRef.current) {
        tvWidgetRef.current.chart().executeActionById('drawingToolbarAction');
      }
    };
    document.addEventListener('tv-show-indicators', handleShowIndicators);
    document.addEventListener('tv-toggle-drawings', handleToggleDrawings);
    return () => {
      document.removeEventListener('tv-show-indicators', handleShowIndicators);
      document.removeEventListener('tv-toggle-drawings', handleToggleDrawings);
    };
  }, []);



  // ── Task 8.2: Widget initialization — runs ONCE on mount ─────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    globalMountCount++;
    const startTime = performance.now();
    loadStartTimeRef.current = startTime;
    console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=CHART_CONTAINER_MOUNT elapsed=0.0ms mountCount=${globalMountCount} unmountCount=${globalUnmountCount}`);

    const armWatchdog = (ms = 25000) => {
      if (initTimerRef.current) clearTimeout(initTimerRef.current);
      initTimerRef.current = setTimeout(() => {
        const elapsed = (performance.now() - startTime).toFixed(1);
        console.warn(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=WATCHDOG_TIMEOUT_FIRED elapsed=${elapsed}ms CHART_FAILED_TO_INITIALIZE`);
        setChartStatus('error');
        setChartError('Chart initialization timed out. Please click Retry.');
      }, ms);
    };

    const initWidget = () => {
      if (!containerRef.current || tvWidgetRef.current) return;

      globalWidgetCreateCount++;
      const initStart = performance.now();
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;
      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=WIDGET_CREATION_START elapsed=${(initStart - startTime).toFixed(1)}ms widgetCreateCount=${globalWidgetCreateCount} containerSize=${width}x${height}`);

      datafeedRef.current = new Datafeed(segment, activeLoadId, startTime);
      if (typeof window !== 'undefined') {
        (window as any).__reactDatafeedInstance = datafeedRef.current;
      }
      datafeedRef.current.onFirstBar = (lastClose, prevClose) => {
        onFirstBarRef.current?.(lastClose, prevClose);
        if (initTimerRef.current) {
          clearTimeout(initTimerRef.current);
          initTimerRef.current = null;
        }
        isReadyRef.current = true;
        setChartStatus('ready');
      };

      datafeedRef.current.onProgress = (event: string) => {
        if (event.startsWith('getBars_end')) {
          if (initTimerRef.current) {
            clearTimeout(initTimerRef.current);
            initTimerRef.current = null;
          }
          isReadyRef.current = true;
          setChartStatus('ready');
        } else {
          // Reset/extend the watchdog whenever datafeed fetch starts
          armWatchdog(25000);
        }
      };

      datafeedRef.current.onError = (errText: string) => {
        if (initTimerRef.current) {
          clearTimeout(initTimerRef.current);
          initTimerRef.current = null;
        }
        setChartStatus('error');
        setChartError(errText || 'Failed to load historical chart data');
      };

      // Clear legacy TradingView localStorage settings that may lock or corrupt price scales / main series visibility
      try {
        localStorage.removeItem('niveshx_tv_layout');
        localStorage.removeItem('marginapexx_tv_layout');
        Object.keys(localStorage).forEach(key => {
          if (key.startsWith('tradingview.')) {
            localStorage.removeItem(key);
          }
        });
      } catch (e) { }

      tvWidgetRef.current = new window.TradingView.widget({
        container: containerRef.current,
        symbol,
        interval: toUdfResolution(timeframe) as any,
        datafeed: datafeedRef.current,
        library_path: '/charting_library/',
        locale: 'en',
        timezone: 'Asia/Kolkata',
        theme: isDark ? 'dark' : 'light',
        autosize: true,
        client_id: 'marginapexx',
        user_id: 'public_user',
        disabled_features: [
          'header_widget',
          'header_symbol_search',
          'header_compare',
          'use_localstorage_for_settings_saved',
          'timeframes_toolbar'
        ],
        enabled_features: [
          'study_templates'
        ],
        overrides: {
          "mainSeriesProperties.showCountdown": false,
          "mainSeriesProperties.visible": true,
          "mainSeriesProperties.style": 1,
          "mainSeriesProperties.priceAxisProperties.autoScale": true,
          "mainSeriesProperties.priceAxisProperties.autoScaleDisabled": false,
          "mainSeriesProperties.priceAxisProperties.percentage": false,
          "mainSeriesProperties.priceAxisProperties.log": false,
          "paneProperties.topMargin": 12,
          "paneProperties.bottomMargin": 12,
          "mainSeriesProperties.candleStyle.upColor": "#089981",
          "mainSeriesProperties.candleStyle.downColor": "#F23645",
          "mainSeriesProperties.candleStyle.drawWick": true,
          "mainSeriesProperties.candleStyle.drawBorder": true,
          "mainSeriesProperties.candleStyle.borderColor": "#089981",
          "mainSeriesProperties.candleStyle.borderUpColor": "#089981",
          "mainSeriesProperties.candleStyle.borderDownColor": "#F23645",
          "mainSeriesProperties.candleStyle.wickColor": "#089981",
          "mainSeriesProperties.candleStyle.wickUpColor": "#089981",
          "mainSeriesProperties.candleStyle.wickDownColor": "#F23645"
        }
      });

      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=WIDGET_CREATION_END elapsed=${(performance.now() - startTime).toFixed(1)}ms`);

      // Monitor for iframe insertion in DOM
      const checkIframeInterval = setInterval(() => {
        const iframe = containerRef.current?.querySelector('iframe');
        if (iframe) {
          clearInterval(checkIframeInterval);
          console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=IFRAME_INSERTED_INTO_DOM elapsed=${(performance.now() - startTime).toFixed(1)}ms`);
        }
      }, 20);

      tvWidgetRef.current.onChartReady(() => onChartReady(startTime, checkIframeInterval));
    };

    const onChartReady = (startTime: number, checkIframeInterval?: ReturnType<typeof setInterval>) => {
      if (checkIframeInterval) clearInterval(checkIframeInterval);
      const readyTime = performance.now();
      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=ON_CHART_READY elapsed=${(readyTime - startTime).toFixed(1)}ms`);
      if (initTimerRef.current) {
        clearTimeout(initTimerRef.current);
        initTimerRef.current = null;
      }
      isReadyRef.current = true;
      setChartStatus('ready');
      try {
        tvWidgetRef.current?.chart().executeActionById('timeScaleReset');
      } catch (e) { }
      console.log(`[CHART TRACE ${activeLoadId}] +${(performance.now() - startTime).toFixed(1)}ms [14] Chart visually usable`);

      // Inject CSS directly to hide native header in case feature flags or custom CSS fail
      try {
        const iframe = containerRef.current?.querySelector('iframe');
        if (iframe && iframe.contentDocument) {
          const style = iframe.contentDocument.createElement('style');
          style.innerHTML = '.layout__area--top { display: none !important; } .header-chart-panel { display: none !important; } .layout__area--center { top: 0 !important; height: 100% !important; }';
          iframe.contentDocument.head.appendChild(style);
        }
      } catch (e) {
        console.error('Failed to inject CSS into TV iframe', e);
      }

      // Drain the pending queue
      const pending = pendingRef.current;
      if (pending.symbol) {
        tvWidgetRef.current?.chart().setSymbol(pending.symbol);
      }
      if (pending.timeframe) {
        tvWidgetRef.current?.chart().setResolution(toUdfResolution(pending.timeframe) as any);
      }
      if (pending.chartType) {
        tvWidgetRef.current?.chart().setChartType(CHART_TYPE_MAP[pending.chartType] as any);
      }
      if (pending.theme) {
        tvWidgetRef.current?.changeTheme(pending.theme);
      }
      pendingRef.current = {};

      const saveChartState = () => {
        if (!tvWidgetRef.current || !isReadyRef.current) return;
        try {
          tvWidgetRef.current.save((state: any) => {
            if (state) {
              try {
                localStorage.setItem('marginapexx_tv_layout', JSON.stringify(state));
              } catch (storageErr) {
                // Quietly handle QuotaExceededError when browser localStorage capacity is reached
              }
            }
          });
        } catch (e) {
          // Ignore save state errors
        }
      };

      // Subscribe to auto save and drawing/indicator changes
      tvWidgetRef.current?.subscribe('onAutoSaveNeeded', saveChartState);
      tvWidgetRef.current?.subscribe('drawing_event', saveChartState);
      tvWidgetRef.current?.subscribe('study_event', saveChartState);
    };

    // Arm initial watchdog
    armWatchdog(25000);

    const scriptCheckTime = performance.now();
    if (window.TradingView) {
      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=TV_SCRIPT_ALREADY_IN_WINDOW elapsed=${(scriptCheckTime - startTime).toFixed(1)}ms`);
      initWidget();
    } else {
      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=TV_SCRIPT_LOADING_START elapsed=${(scriptCheckTime - startTime).toFixed(1)}ms`);
      const script = document.createElement('script');
      script.src = '/charting_library/charting_library.standalone.js';
      script.onload = () => {
        console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=TV_SCRIPT_ONLOAD_FIRED elapsed=${(performance.now() - startTime).toFixed(1)}ms`);
        initWidget();
      };
      script.onerror = (err) => {
        console.error(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=TV_SCRIPT_LOAD_ERROR elapsed=${(performance.now() - startTime).toFixed(1)}ms`, err);
      };
      document.head.appendChild(script);
    }

    return () => {
      globalUnmountCount++;
      globalWidgetDestroyCount++;
      console.log(`[PROD-CHART] timestamp=${Date.now()} loadId=${activeLoadId} symbol=${symbol} resolution=${timeframe} event=CHART_CONTAINER_UNMOUNT elapsed=${(performance.now() - loadStartTimeRef.current).toFixed(1)}ms`);
      if (initTimerRef.current) {
        clearTimeout(initTimerRef.current);
        initTimerRef.current = null;
      }
      tvWidgetRef.current?.remove();
      tvWidgetRef.current = null;
      datafeedRef.current = null;
      isReadyRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Task 8.3: symbol, timeframe, chartType effects ───────────────────────

  useEffect(() => {
    if (datafeedRef.current) {
      datafeedRef.current.setSegment(segment);
    }
    if (!isReadyRef.current) { pendingRef.current.symbol = symbol; return; }
    tvWidgetRef.current?.chart().setSymbol(symbol, () => {
      try {
        tvWidgetRef.current?.chart().executeActionById('timeScaleReset');
      } catch (e) { }
    });
  }, [symbol, segment]);

  useEffect(() => {
    if (!isReadyRef.current) { pendingRef.current.timeframe = timeframe; return; }
    tvWidgetRef.current?.chart().setResolution(toUdfResolution(timeframe) as any);
  }, [timeframe]);

  useEffect(() => {
    if (!isReadyRef.current) { pendingRef.current.chartType = chartType; return; }
    tvWidgetRef.current?.chart().setChartType(CHART_TYPE_MAP[chartType] as any);
  }, [chartType]);

  // ── Task 8.5: Live quote forwarding ──────────────────────────────────────
  const { quotes: marketQuotes } = useMarketQuotes([symbol]);
  const activeQuote: any = marketQuotes[symbol] || liveQuote;

  useEffect(() => {
    let lastPrice = activeQuote?.lastPrice ?? activeQuote?.last_price;
    if (lastPrice !== undefined) lastPrice = Number(lastPrice);

    let volume = activeQuote?.volume ?? activeQuote?.v;
    if (volume !== undefined) volume = Number(volume);

    let nowMs = activeQuote?.timestamp ? new Date(activeQuote.timestamp).getTime() : Date.now();
    if (nowMs !== undefined) nowMs = Number(nowMs);

    if (chartStatus !== 'ready') return;
    if (!lastPrice || !isFinite(lastPrice) || lastPrice <= 0) return;

    datafeedRef.current?.updateLive(symbol, lastPrice, nowMs, volume);
  }, [activeQuote, symbol, loading, candles.length]);

  // ── Task 8.5: Theme sync via MutationObserver ─────────────────────────────

  useEffect(() => {
    const syncTheme = () => {
      const dark = getIsDark();
      setIsDark(dark);
      const theme = dark ? 'dark' : 'light';
      if (!isReadyRef.current) { pendingRef.current.theme = theme; }
      else {
        tvWidgetRef.current?.changeTheme(theme);
      }
      try {
        const iframe = containerRef.current?.querySelector('iframe');
        if (iframe) {
          const appTheme = getSavedTheme();
          iframe.setAttribute('data-theme', appTheme);
          if (iframe.contentDocument && iframe.contentDocument.documentElement) {
            iframe.contentDocument.documentElement.setAttribute('data-theme', appTheme);
          }
        }
      } catch (e) {}
    };

    syncTheme();

    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme'] });

    window.addEventListener('themeChanged', syncTheme);
    window.addEventListener('storage', syncTheme);

    return () => {
      observer.disconnect();
      window.removeEventListener('themeChanged', syncTheme);
      window.removeEventListener('storage', syncTheme);
    };
  }, []);

  // ── Task 8.6: Render ──────────────────────────────────────────────────────

  return (
    <div style={{ position: 'relative', flex: 1, width: '100%', height: '100%', overflow: 'hidden' }}>

      {/* Widget mount target */}
      <div
        ref={containerRef}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, height: '100%' }}
      />

      {/* Loading overlay */}
      {(chartStatus === 'loading' || loading) && (
        <div style={{
          position: 'absolute',
          inset: 0,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: isDark ? 'rgba(7, 24, 36, 0.88)' : 'rgba(255, 255, 255, 0.88)',
          backdropFilter: 'blur(3px)',
        }}>
          <AnimatedLoader text={`Loading ${formatShortName(symbol.includes(':') ? symbol.split(':')[1] : symbol)} chart...`} fullScreen={false} />
        </div>
      )}

      {/* Error overlay (widget-level error or timeout) */}
      {chartStatus === 'error' && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px',
          background: isDark ? '#071824' : '#FFFFFF',
        }}>
          <div style={{ color: '#F23645', fontSize: '13px', fontWeight: 600, maxWidth: '80%', textAlign: 'center' }}>
            {chartError}
          </div>
          <button
            onClick={() => {
              setChartStatus('loading');
              setChartError(null);
              if (tvWidgetRef.current) {
                try { tvWidgetRef.current.remove(); } catch (e) { }
                tvWidgetRef.current = null;
              }
              // re-trigger mount effect by clearing ready ref
              isReadyRef.current = false;
              window.location.reload();
            }}
            style={{
              padding: '6px 16px', background: '#2962FF', color: '#FFF', border: 'none',
              borderRadius: '4px', fontSize: '12px', fontWeight: 600, cursor: 'pointer'
            }}
          >
            Retry Chart
          </button>
        </div>
      )}

      {/* Error prop text (data fetch error — no candles yet) */}
      {error !== null && !loading && candles.length === 0 && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: isDark ? '#071824' : '#FFFFFF',
        }}>
          <div style={{ color: '#F23645', fontSize: '13px', fontWeight: 600, maxWidth: '80%', textAlign: 'center' }}>
            {error}
          </div>
        </div>
      )}
    </div>
  );
}
