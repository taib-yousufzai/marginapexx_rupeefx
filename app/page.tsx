'use client';

import React, { useState, useEffect, useRef } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

import { getSession, getRole } from '@/lib/auth';
import { api, ApiError } from '@/lib/api';
import { useMarketQuotes } from '@/hooks/useMarketQuotes';
import { isContractExpired, getCurrentFuturesSymbol } from '@/lib/contractExpiry';
import { useTradeConfig } from '@/contexts/TradeConfigContext';

import AnimatedLoader from '@/components/AnimatedLoader';
import TickFlash from '@/components/TickFlash';
import { getSavedTheme, applyTheme, cycleTheme, Theme } from '@/lib/theme';
import './page.css';

// --- Kite instrument keys for the market overview ---
const getInitialMarketRow1 = () => [
  'NSE:NIFTY 50',
  'BSE:SENSEX',
  'NSE:NIFTY BANK',
  getCurrentFuturesSymbol('CDS', 'USDINR'),
];

const getInitialMarketRow2 = () => [
  getCurrentFuturesSymbol('MCX', 'CRUDEOIL'),
  getCurrentFuturesSymbol('MCX', 'GOLD'),
  getCurrentFuturesSymbol('MCX', 'SILVER'),
  getCurrentFuturesSymbol('MCX', 'NATURALGAS'),
];

const BASE_DISPLAY_MAP: Record<string, { name: string; icon: string }> = {
  'NIFTY 50': { name: 'NIFTY 50', icon: 'fas fa-chart-line' },
  'SENSEX': { name: 'SENSEX', icon: 'fas fa-chart-area' },
  'NIFTY BANK': { name: 'BANK NIFTY', icon: 'fas fa-building' },
  'USDINR': { name: 'USD/INR', icon: 'fas fa-dollar-sign' },
  'CRUDEOIL': { name: 'CRUDE OIL', icon: 'fas fa-oil-can' },
  'GOLD': { name: 'GOLD', icon: 'fas fa-coins' },
  'SILVER': { name: 'SILVER', icon: 'fas fa-gem' },
  'NATURALGAS': { name: 'NAT GAS', icon: 'fas fa-fire' },
};

function getDisplayInfo(key: string): { name: string; icon: string } {
  const upper = key.toUpperCase();
  if (upper.includes('NIFTY 50')) return BASE_DISPLAY_MAP['NIFTY 50'];
  if (upper.includes('SENSEX')) return BASE_DISPLAY_MAP['SENSEX'];
  if (upper.includes('NIFTY BANK')) return BASE_DISPLAY_MAP['NIFTY BANK'];
  if (upper.includes('USDINR')) return BASE_DISPLAY_MAP['USDINR'];
  if (upper.includes('CRUDEOIL')) return BASE_DISPLAY_MAP['CRUDEOIL'];
  if (upper.includes('GOLD')) return BASE_DISPLAY_MAP['GOLD'];
  if (upper.includes('SILVER')) return BASE_DISPLAY_MAP['SILVER'];
  if (upper.includes('NATURALGAS')) return BASE_DISPLAY_MAP['NATURALGAS'];
  return { name: key, icon: 'fas fa-chart-line' };
}

type MarketItem = { name: string; price: number; change: number; changeAmt?: number; type: string; icon: string };

type LearningItem = {
  id: number;
  name: string;
  icon: any;
  isSvg?: boolean;
  iconClass: string;
  badge: string;
  action: string;
};

const learningData: LearningItem[] = [
  { id: 1, name: "Try Algo", icon: "fas fa-chart-line", iconClass: "algo", badge: "Free", action: "algo" },
  { 
    id: 2, 
    name: "Scanner", 
    isSvg: true,
    icon: (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="1.4em" height="1.4em">
        <path d="M3 8V5a2 2 0 0 1 2-2h3"/>
        <path d="M16 3h3a2 2 0 0 1 2 2v3"/>
        <path d="M21 16v3a2 2 0 0 1-2 2h-3"/>
        <path d="M8 21H5a2 2 0 0 1-2-2v-3"/>
        <line className="scanner-line" x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth="2" />
      </svg>
    ), 
    iconClass: "ai", 
    badge: "Beta", 
    action: "ai" 
  },
  { id: 3, name: "Indicator", icon: "fas fa-chart-bar", iconClass: "indicator", badge: "Pro", action: "indicator" },
  { id: 4, name: "Course", icon: "fas fa-video", iconClass: "default", badge: "Enroll", action: "course" },
  { id: 5, name: "Classes", icon: "fas fa-chalkboard-user", iconClass: "default", badge: "Live", action: "classes" },
  { id: 6, name: "Books", icon: "fas fa-book", iconClass: "default", badge: "Free", action: "books" }
];

const equityInstruments = [
  { name: "NIFTY", icon: "fas fa-chart-line", sub: "50 Stocks" },
  { name: "SENSEX", icon: "fas fa-chart-area", sub: "30 Stocks" },
  { name: "BANKNIFTY", icon: "fas fa-building", sub: "Banking" },
  { name: "BANKEX", icon: "fas fa-university", sub: "Bank Index" },
  { name: "FINNIFTY", icon: "fas fa-chart-pie", sub: "Financial" },
  { name: "MIDCAP", icon: "fas fa-chart-bar", sub: "Mid Cap" }
];

const commodityInstruments = [
  { name: "GOLD", icon: "fas fa-coins", sub: "Gold Spot" },
  { name: "SILVER", icon: "fas fa-gem", sub: "Silver" },
  { name: "CRUDEOIL", icon: "fas fa-oil-can", sub: "Crude Oil" },
  { name: "NATURALGAS", icon: "fas fa-fire", sub: "Nat Gas" },
  { name: "GOLDM", icon: "fas fa-coins", sub: "Mini Gold" },
  { name: "SILVERM", icon: "fas fa-gem", sub: "Mini Silver" },
  { name: "CRUDEOILM", icon: "fas fa-oil-can", sub: "Mini Crude" },
  { name: "NATGASMINI", icon: "fas fa-fire", sub: "Mini NG" }
];

const getNextExpiryDate = (dayOfWeek: number) => {
  const today = new Date();
  const todayDay = today.getDay();
  let daysUntil = dayOfWeek - todayDay;
  if (daysUntil < 0) daysUntil += 7;
  const targetDate = new Date(today);
  targetDate.setDate(today.getDate() + daysUntil);
  return {
    dateStr: targetDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    isToday: daysUntil === 0
  };
};

const getLastTuesdayOfCurrentOrNextMonth = () => {
  const getLastTuesday = (year: number, month: number) => {
    const date = new Date(year, month + 1, 0);
    const day = date.getDay();
    const diff = (day >= 2) ? (day - 2) : (day + 5);
    date.setDate(date.getDate() - diff);
    return date;
  };

  const today = new Date();
  const todayZero = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let lastTuesday = getLastTuesday(today.getFullYear(), today.getMonth());
  if (lastTuesday < todayZero) {
    const nextMonth = today.getMonth() === 11 ? 0 : today.getMonth() + 1;
    const nextYear = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
    lastTuesday = getLastTuesday(nextYear, nextMonth);
  }
  const daysDiff = Math.ceil((lastTuesday.getTime() - todayZero.getTime()) / (1000 * 60 * 60 * 24));
  return {
    dateStr: lastTuesday.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    isToday: daysDiff === 0
  };
};

const getLastThursdayOfCurrentOrNextMonth = () => {
  const getLastThursday = (year: number, month: number) => {
    const date = new Date(year, month + 1, 0);
    const day = date.getDay();
    const diff = (day >= 4) ? (day - 4) : (day + 3);
    date.setDate(date.getDate() - diff);
    return date;
  };

  const today = new Date();
  const todayZero = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  let lastThursday = getLastThursday(today.getFullYear(), today.getMonth());
  if (lastThursday < todayZero) {
    const nextMonth = today.getMonth() === 11 ? 0 : today.getMonth() + 1;
    const nextYear = today.getMonth() === 11 ? today.getFullYear() + 1 : today.getFullYear();
    lastThursday = getLastThursday(nextYear, nextMonth);
  }
  const daysDiff = Math.ceil((lastThursday.getTime() - todayZero.getTime()) / (1000 * 60 * 60 * 24));
  return {
    dateStr: lastThursday.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    isToday: daysDiff === 0
  };
};

const getExpiryIndexes = () => [
  { name: "NIFTY", fullName: "NIFTY 50", shortCode: "N50", expiry: getNextExpiryDate(4), lotSize: 65 }, // Thursday
  { name: "BANKNIFTY", fullName: "BANK NIFTY", shortCode: "BNF", expiry: getNextExpiryDate(3), lotSize: 30 }, // Wednesday
  { name: "FINNIFTY", fullName: "FIN NIFTY", shortCode: "FIN", expiry: getNextExpiryDate(2), lotSize: 60 }, // Tuesday
  { name: "SENSEX", fullName: "SENSEX", shortCode: "SEN", expiry: getNextExpiryDate(5), lotSize: 20 }, // Friday
  { name: "MIDCAP", fullName: "MIDCAP NIFTY", shortCode: "MID", expiry: getNextExpiryDate(1), lotSize: 120 }, // Monday
  { name: "BANKEX", fullName: "BANKEX", shortCode: "BKX", expiry: getNextExpiryDate(1), lotSize: 30 }, // Monday
];




export default function Page() {
  const containerRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const router = useRouter();
  const [allowedSegments, setAllowedSegments] = useState<string[]>([]);
  // scriptSettings comes from the shared TradeConfigProvider
  const { scriptSettings } = useTradeConfig();

  useEffect(() => {
    getSession().then((session) => {
      if (!session) { router.replace('/login'); return; }
      const role = getRole(session.user);
      if (role === 'admin' || role === 'super_admin') { router.replace('/admin'); return; }
      if (role === 'broker') { router.replace('/broker'); return; }
    });
  }, [router]);

  useEffect(() => {
    if (containerRef.current) containerRef.current.scrollTop = 0;
  }, [pathname]);

  useEffect(() => {
    async function fetchAllowedSegments() {
      try {
        const profile = await api.get<{ segments?: string[] }>('/api/user/profile');
        if (profile && profile.segments) {
          setAllowedSegments(profile.segments);
        }
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status !== 401) {
            console.error('Failed to fetch allowed segments', err.status, err.details);
          }
        } else {
          console.error('Failed to fetch allowed segments', err);
        }
      }
    }
    fetchAllowedSegments();
  }, []);

  const [activeCategory, setActiveCategory] = useState<'equity' | 'commodity'>('equity');
  const [theme, setTheme] = useState<'light' | 'dark' | 'black' | 'blue'>('light');
  const [isExpiryDrawerOpen, setIsExpiryDrawerOpen] = useState(false);

  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<{ id: string; title: string; message: string; read?: boolean }[]>([]);
  const [isNotifDrawerOpen, setIsNotifDrawerOpen] = useState(false);
  const [dbExpiries, setDbExpiries] = useState<Record<string, string>>({});

  useEffect(() => {
    async function fetchExpiries() {
      try {
        const json = await api.get<{ success: boolean; expiries?: Record<string, string> }>('/api/market/expiries');
        if (json.success && json.expiries) {
          setDbExpiries(json.expiries);
        }
      } catch (err) {
        console.error('Failed to fetch expiries', err);
      }
    }
    fetchExpiries();
  }, []);

  // Build expiry index list, overriding hardcoded lot sizes with DB values and real expiries
  const expiryIndexes = getExpiryIndexes().map(item => {
    const n = item.name.toUpperCase();
    const dbName = n === 'MIDCAP' ? 'MIDCPNIFTY' : n;
    
    let finalExpiry = item.expiry; // fallback to calculated
    const realExpiryDateStr = dbExpiries[dbName];
    if (realExpiryDateStr) {
       const realDate = new Date(realExpiryDateStr);
       const today = new Date();
       const isToday = realDate.getDate() === today.getDate() && realDate.getMonth() === today.getMonth() && realDate.getFullYear() === today.getFullYear();
       finalExpiry = {
          dateStr: realDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
          isToday
       };
    }

    const dbMatch = scriptSettings.find(s => n.includes(s.symbol.toUpperCase()) || s.symbol.toUpperCase().includes(n));
    return dbMatch ? { ...item, expiry: finalExpiry, lotSize: Number(dbMatch.lot_size) } : { ...item, expiry: finalExpiry };
  });

  const [tradingHours, setTradingHours] = useState<{ id: string; name: string; start_time: string; end_time: string; is_active: boolean }[]>([]);

  useEffect(() => {
    async function fetchTradingHours() {
      const { data, error } = await supabase
        .from('trading_hours')
        .select('*')
        .eq('is_active', true);
      if (!error && data) {
        setTradingHours(data);
      }
    }
    fetchTradingHours();
  }, []);

  const getSegmentStatus = (seg: { start_time: string; end_time: string }) => {
    const nowIST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const dayOfWeek = nowIST.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    if (isWeekend) {
      return { status: 'closed', label: 'Closed (Weekend)' };
    }

    const currentHHMM = `${String(nowIST.getHours()).padStart(2, '0')}:${String(nowIST.getMinutes()).padStart(2, '0')}`;

    if (currentHHMM < seg.start_time) {
      return { status: 'closed', label: `Closed (Opens ${seg.start_time})` };
    } else if (currentHHMM >= seg.end_time) {
      return { status: 'closed', label: `Closed (Closed at ${seg.end_time})` };
    } else {
      return { status: 'open', label: `Open (Closes ${seg.end_time})` };
    }
  };



  useEffect(() => {
    const fetchNotifications = async () => {
      try {
        const result = await api.get<{ notifications?: { id: string; title: string; message: string; read?: boolean }[] }>('/api/notifications?limit=20');
        if (result && result.notifications) {
          const list = result.notifications ?? [];
          setNotifications(list);
        }
      } catch (err: any) {
        if (err instanceof ApiError) {
          if (err.status !== 401) {
            console.error('Failed to fetch notifications', err.status, err.details);
          }
        } else {
          console.error('Failed to fetch notifications', err);
        }
      }
    };
    fetchNotifications();
  }, []);

  // Mark all notifications as read when the drawer is opened
  useEffect(() => {
    if (isNotifDrawerOpen && notifications.some(n => !n.read)) {
      const markAllRead = async () => {
        try {
          await api.patch<void>('/api/notifications/all', {});
          setNotifications(prev => prev.map(n => ({ ...n, read: true })));
        } catch (err) {
          if (err instanceof ApiError) {
            console.error('Failed to mark notifications as read', err.status, err.details);
          } else {
            console.error('Failed to mark notifications as read', err);
          }
        }
      };
      markAllRead();
    }
  }, [isNotifDrawerOpen, notifications]);

  const [marketRow1Keys, setMarketRow1Keys] = useState<string[]>(getInitialMarketRow1);
  const [marketRow2Keys, setMarketRow2Keys] = useState<string[]>(getInitialMarketRow2);
  const [isResolvingContracts, setIsResolvingContracts] = useState<boolean>(false);

  useEffect(() => {
    async function resolveExpiredContracts() {
      const initialR1 = getInitialMarketRow1();
      const initialR2 = getInitialMarketRow2();
      const allKeys = [...initialR1, ...initialR2];
      
      // Fast path: If all initial contracts are already active and valid, skip DB queries entirely
      const hasExpired = allKeys.some(k => isContractExpired(k));
      if (!hasExpired) {
        return;
      }

      setIsResolvingContracts(true);
      try {
        const bases = [
          { name: 'USDINR', prefix: 'CDS', type: ['FUT'] },
          { name: 'CRUDEOIL', prefix: 'MCX', type: ['FUTCOM', 'FUT', 'MAPPED_FUT'] },
          { name: 'GOLD', prefix: 'MCX', type: ['FUTCOM', 'FUT', 'MAPPED_FUT'] },
          { name: 'SILVER', prefix: 'MCX', type: ['FUTCOM', 'FUT', 'MAPPED_FUT'] },
          { name: 'NATURALGAS', prefix: 'MCX', type: ['FUTCOM', 'FUT', 'MAPPED_FUT'] }
        ];

        const newRow1 = [...initialR1];
        const newRow2 = [...initialR2];
        let changed = false;

        // Query in parallel with 1500ms timeout instead of 5 sequential blocking queries
        const todayStr = new Date().toISOString().split('T')[0];
        await Promise.all(bases.map(async (base) => {
          const row1Idx = newRow1.findIndex(k => k.includes(base.name));
          const row2Idx = newRow2.findIndex(k => k.includes(base.name));
          
          if (row1Idx !== -1 || row2Idx !== -1) {
            const queryPromise = supabase
              .from('instruments')
              .select('tradingsymbol')
              .eq('name', base.name)
              .in('instrument_type', base.type)
              .gte('expiry', todayStr)
              .order('expiry', { ascending: true })
              .limit(1)
              .maybeSingle();

            const timeoutPromise = new Promise<{ data: any }>((resolve) =>
              setTimeout(() => resolve({ data: null }), 1500)
            );

            const { data } = await Promise.race([queryPromise, timeoutPromise]);

            if (data?.tradingsymbol) {
              const resolvedKey = `${base.prefix}:${data.tradingsymbol}`;
              if (row1Idx !== -1 && newRow1[row1Idx] !== resolvedKey) {
                newRow1[row1Idx] = resolvedKey;
                changed = true;
              }
              if (row2Idx !== -1 && newRow2[row2Idx] !== resolvedKey) {
                newRow2[row2Idx] = resolvedKey;
                changed = true;
              }
            }
          }
        }));

        if (changed) {
          setMarketRow1Keys(newRow1);
          setMarketRow2Keys(newRow2);
        }
      } catch (err) {
        console.error('Error resolving expired contracts:', err);
      } finally {
        setIsResolvingContracts(false);
      }
    }

    resolveExpiredContracts();
  }, []);

  const allKiteInstruments = [...marketRow1Keys, ...marketRow2Keys];
  const {
    quotes,
    isLoading: marketLoading,
    isUnreachable: marketUnreachable,
    connectionStatus,
    lastError,
    reconnectCount
  } = useMarketQuotes(allKiteInstruments);
  const kiteConnected = connectionStatus === 'connected';
  const kiteLoading = marketLoading;

  const buildRow = (instruments: string[]): (MarketItem & { expired?: boolean })[] => {
    return instruments.map((key) => {
      const q = quotes[key];
      const display = getDisplayInfo(key);
      const expired = !isResolvingContracts && isContractExpired(key);
      if (expired) {
        // Don't show stale 0/0 values — surface expiry to the user instead
        return { name: display.name, price: 0, change: 0, changeAmt: 0, type: 'positive', icon: display.icon, expired: true };
      }
      if (!q) return { name: display.name, price: 0, change: 0, changeAmt: 0, type: 'positive', icon: display.icon };
      return {
        name: display.name,
        price: q.lastPrice,
        change: q.changePercent,
        changeAmt: q.change,
        type: q.changePercent >= 0 ? 'positive' : 'negative',
        icon: display.icon,
      };
    });
  };

  const marketRow1 = buildRow(marketRow1Keys);
  const marketRow2 = buildRow(marketRow2Keys);

  useEffect(() => {
    const syncThemeState = () => {
      setTheme(getSavedTheme());
    };
    syncThemeState();
    window.addEventListener('themeChanged', syncThemeState);
    return () => window.removeEventListener('themeChanged', syncThemeState);
  }, []);

  const toggleTheme = () => {
    const nextTheme = cycleTheme(theme as Theme);
    setTheme(nextTheme);
    applyTheme(nextTheme);
  };

  const mapOptionChainSymbolToDbSegment = (sym: string): string => {
    const s = sym.toUpperCase().trim();
    if (['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCAP', 'SENSEX', 'BANKEX'].includes(s)) {
      return 'INDEX-OPT';
    }
    if (['GOLD', 'SILVER', 'CRUDEOIL', 'NATURALGAS', 'GOLDM', 'SILVERM', 'CRUDEOILM', 'NATGASMINI'].includes(s)) {
      return 'MCX-OPT';
    }
    return 'STOCK-OPT';
  };

  const filteredEquityInstruments = equityInstruments.filter(inst => {
    if (allowedSegments.length === 0) return true;
    const dbSeg = mapOptionChainSymbolToDbSegment(inst.name);
    return allowedSegments.includes(dbSeg);
  });

  const filteredCommodityInstruments = commodityInstruments.filter(inst => {
    if (allowedSegments.length === 0) return true;
    const dbSeg = mapOptionChainSymbolToDbSegment(inst.name);
    return allowedSegments.includes(dbSeg);
  });

  const instruments = activeCategory === 'equity' ? filteredEquityInstruments : filteredCommodityInstruments;

  const filteredExpiryIndexes = expiryIndexes
    .filter(item => {
      if (allowedSegments.length === 0) return true;
      const dbSeg = mapOptionChainSymbolToDbSegment(item.name);
      return allowedSegments.includes(dbSeg);
    })
    .sort((a, b) => {
      if (a.expiry.isToday && !b.expiry.isToday) return -1;
      if (!a.expiry.isToday && b.expiry.isToday) return 1;
      return 0;
    });

  return (
    <div className="desktop-layout home-isolated-layout">
      
      <main className="main-viewport home-isolated-viewport">
        <div className="app-container home-isolated-container">
          {/* Mobile Navigation Bar */}
          <div className="nav-bar-full mobile-only">
            <div className="nav-icon-btn" onClick={() => setIsNotifDrawerOpen(true)}><i className="fas fa-bell"></i></div>
            <div className="nav-app-name">MARGIN<span style={{ color: '#006400' }}>APEX</span></div>
            <div className="nav-group">
              <div className="nav-icon-btn" onClick={toggleTheme}><i className={(theme === 'dark' || theme === 'black' || theme === 'blue') ? "fas fa-sun" : "fas fa-moon"}></i></div>
              <div className="nav-funds" onClick={() => router.push('/funds')}><i className="fas fa-coins"></i><span>Funds</span></div>
              <div className="nav-icon-btn" onClick={() => router.push('/profile')}><i className="fas fa-user-cog"></i></div>
            </div>
          </div>

          <div ref={containerRef} className="main-scroll-wrapper home-isolated-scroll">
            <div className="main-content">
              <div className="screen">
                <div className="content-padded">
                  {/* WhatsApp Community */}
                  <div className="whatsapp-community" onClick={() => window.open(process.env.NEXT_PUBLIC_WHATSAPP_COMMUNITY_LINK || 'https://chat.whatsapp.com/BqxIlyVnRQNIJ2JB2swEVh', '_blank')}>
                    <div className="whatsapp-inner">
                      <div className="whatsapp-icon"><i className="fab fa-whatsapp"></i></div>
                      <div className="whatsapp-content">
                        <div className="whatsapp-headline">FREE WHATSAPP COMMUNITY</div>
                        <div className="whatsapp-sub"><i className="fas fa-lightbulb"></i> You&apos;ll get FREE tips here — join now!</div>
                      </div>
                      <div className="whatsapp-arrow"><i className="fas fa-chevron-right"></i></div>
                    </div>
                  </div>

                  {/* Margin Settings */}
                  <div className="margin-settings-row" onClick={() => router.push('/margin-settings')}>
                    <div className="margin-settings-left">
                      <div className="margin-settings-icon"><i className="fas fa-chart-line"></i></div>
                      <div className="margin-settings-text"><h4>Margin Settings</h4><p>Check your trading margin and limits</p></div>
                    </div>
                    <div className="margin-settings-arrow"><i className="fas fa-arrow-right"></i></div>
                  </div>



                  {/* Option Chain */}
                  <div className="option-chain-section">
                    <div className="section-header">
                      <div className="section-title"><i className="fas fa-link"></i> OPTION CHAIN</div>
                      <span className="mobile-only" style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>Swipe →</span>
                    </div>
                    <div className="category-toggle-wrapper">
                      <div className={`category-toggle-slider ${activeCategory === 'commodity' ? 'slide-right' : ''}`}></div>
                      <div className={`cat-btn ${activeCategory === 'equity' ? 'active' : ''}`} onClick={() => setActiveCategory('equity')}>EQUITY</div>
                      <div className={`cat-btn ${activeCategory === 'commodity' ? 'active' : ''}`} onClick={() => setActiveCategory('commodity')}>COMMODITY</div>
                    </div>
                    <div className="scrollable-instruments">
                      <div className="instruments-row">
                        {instruments.map((inst, i) => (
                          <div className="circle-instrument" key={i} onClick={() => router.push(`/option-chain?symbol=${encodeURIComponent(inst.name)}`)}>
                            <div className="circle-icon"><i className={inst.icon}></i></div>
                            <div className="circle-label">{inst.name}</div>
                            <div className="circle-sub">{inst.sub}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Expiry Today */}
                  <div className="expiry-block" onClick={() => setIsExpiryDrawerOpen(true)}>
                    <div className="expiry-left">
                      <div className="expiry-icon"><i className="fas fa-calendar-day"></i></div>
                      <div className="expiry-text">
                        <h4>EXPIRY TODAY</h4>
                        <p>
                          {expiryIndexes.filter(item => item.expiry.isToday).map(item => item.fullName).join(" & ") || "No Expiry Today"}
                        </p>
                      </div>
                    </div>
                    <div className="expiry-arrow"><i className="fas fa-arrow-right"></i></div>
                  </div>

                  {/* Market Overview */}
                  <div className="market-overview">
                    <div className="overview-header">
                      <h4>Live Market Overview</h4>
                      {kiteConnected && (
                        <span className="live-badge"><span className="live-dot" /> LIVE</span>
                      )}
                    </div>



                    {kiteLoading && (
                      <div className="market-status-msg" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <AnimatedLoader size="small" /> Checking connection…
                      </div>
                    )}



                    {!kiteLoading && Object.keys(quotes).length > 0 && (
                      <div className="markets-two-rows">
                        {[marketRow1, marketRow2].map((row, rowIdx) => (
                          <div className="market-row-scroll" key={`row-${rowIdx}`}>
                            <div className="market-row-blocks">
                              {row.map((market, i) => (
                                <div
                                  className={`market-rectangle${(market as any).expired ? ' market-rectangle--expired' : ''}`}
                                  key={i}
                                  onClick={() => !(market as any).expired && router.push(`/watchlist?symbol=${encodeURIComponent(market.name)}`)}
                                  style={(market as any).expired ? { cursor: 'default', opacity: 0.6 } : undefined}
                                >
                                  <div className="market-rect-header">
                                    <span className="market-rect-name">{market.name}</span>
                                  </div>
                                  {(market as any).expired ? (
                                    <>
                                      <div className="market-rect-expired-badge">
                                        <i className="fas fa-calendar-xmark" style={{ marginRight: 4 }} />
                                        Contract Expired
                                      </div>
                                      <div className="market-rect-expired-sub">Update contract symbol</div>
                                    </>
                                  ) : (
                                    <>
                                      <div className="market-rect-price">
                                        <TickFlash value={market.price}>
                                          {market.price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                        </TickFlash>
                                      </div>
                                      <div className={`market-rect-change ${market.type}`}>
                                        {market.change >= 0
                                          ? `+${(market.changeAmt ?? 0).toFixed(2)} (+${market.change.toFixed(2)}%)`
                                          : `${(market.changeAmt ?? 0).toFixed(2)} (${market.change.toFixed(2)}%)`}
                                      </div>
                                    </>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {marketUnreachable && (
                      <div className="market-status-msg" style={{ padding: '20px', textAlign: 'center', color: 'var(--red)', fontSize: '0.9rem' }}>
                        <i className="fas fa-exclamation-triangle" style={{ marginRight: '8px' }}></i>
                        Market data server is currently unreachable.
                        {lastError && <div style={{ fontSize: '0.75rem', marginTop: '4px', opacity: 0.8 }}>Reason: {lastError} (Retries: {reconnectCount})</div>}
                      </div>
                    )}
                  </div>

                  {/* AI & Learning */}
                  <div className="learning-section">
                    <div className="section-title"><i className="fas fa-robot"></i> AI &amp; LEARNING</div>
                    <div className="learning-grid">
                      {learningData.map((item, i) => (
                        <div className="learning-card" key={i} onClick={() => router.push(`/learning/${item.action}`)}>
                          <div className={`learning-icon ${item.iconClass}`}>
                            {item.isSvg ? item.icon : <i className={item.icon as string}></i>}
                          </div>
                          <div className="learning-title">{item.name}</div>
                          <div className="learning-badge">{item.badge}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* WhatsApp Support */}
                  <div className="whatsapp-support" onClick={() => window.open('https://wa.me/918796119115', '_blank')}>
                    <div className="whatsapp-inner">
                      <div className="whatsapp-icon"><i className="fab fa-whatsapp"></i></div>
                      <div className="whatsapp-content">
                        <div className="whatsapp-headline">24/7 WHATSAPP SUPPORT</div>
                        <div className="whatsapp-sub"><i className="fas fa-headset"></i> Get instant help anytime</div>
                      </div>
                      <div className="whatsapp-arrow"><i className="fas fa-chevron-right"></i></div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

                  </div>

        {/* Drawers */}
        <div className={`expiry-half-drawer-overlay ${isExpiryDrawerOpen ? 'active' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setIsExpiryDrawerOpen(false); }}>
          <div className="expiry-half-sheet ew-sheet">
            {/* drag handle */}
            <div className="ew-handle"></div>

            {/* Header */}
            <div className="ew-header">
              <div className="ew-header-left">
                <div className="ew-cal-icon"><i className="fas fa-calendar-check"></i></div>
                <span className="ew-title">Expiry watchlist</span>
              </div>
              <button className="ew-close" onClick={() => setIsExpiryDrawerOpen(false)}>✕</button>
            </div>
            {/* List */}
            <div className="ew-list">
              {filteredExpiryIndexes.map((item, i) => (
                <div
                  key={i}
                  className={`ew-item${item.expiry.isToday ? ' ew-item--today' : ''}`}
                  onClick={() => {
                    setIsExpiryDrawerOpen(false);
                    router.push(`/option-chain?symbol=${encodeURIComponent(item.name)}`);
                  }}
                >
                  {/* EXPIRES TODAY banner */}
                  {item.expiry.isToday && (
                    <div className="ew-today-banner">
                      <span>EXPIRES TODAY</span>
                    </div>
                  )}

                  {/* Short code badge */}
                  <div className="ew-code">{item.shortCode}</div>

                  {/* Info */}
                  <div className="ew-info">
                    <div className="ew-name">{item.fullName}</div>
                    <div className="ew-meta">
                      <span className="ew-date-pill">{item.expiry.dateStr}</span>
                      <span className="ew-lot">Lot: {item.lotSize}</span>
                    </div>
                  </div>

                  {/* Arrow */}
                  <div className={`ew-arrow${item.expiry.isToday ? ' ew-arrow--today' : ''}`}>
                    <i className="fas fa-chevron-right"></i>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className={`expiry-half-drawer-overlay ${isNotifDrawerOpen ? 'active' : ''}`} onClick={(e) => { if (e.target === e.currentTarget) setIsNotifDrawerOpen(false); }}>
          <div className="notif-sheet">
            <div className="notif-sheet-header">
              <h3 className="notif-sheet-title">Notifications</h3>
              <div className="notif-sheet-subtitle">{notifications.filter(n => !n.read).length} unread</div>
            </div>
            <div className="notif-sheet-body">
              {notifications.length === 0 ? (
                <div className="notif-empty-state">No notifications 🎉</div>
              ) : (
                <div className="notif-list">
                  {notifications.map(n => (
                    <div key={n.id} className="notif-item">
                      <div className="notif-title">{n.title}</div>
                      <div className="notif-msg">{n.message}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="notif-sheet-footer">
              <button className="notif-close-btn" onClick={() => setIsNotifDrawerOpen(false)}>Close</button>
            </div>
          </div>
        </div>

        {toastMessage && <div className="toast-msg">{toastMessage}</div>}


      </main>
    </div>
  );
}
