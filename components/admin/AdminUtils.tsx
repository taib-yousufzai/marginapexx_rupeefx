'use client';
import React, { useEffect } from 'react';
import { supabase } from '@/lib/supabaseClient';

// ─── Constants ───────────────────────────────────────────────────────────────
export const TAB_INSTRUMENTS: Record<string, string[]> = {
  'INDEX-FUT': ['NSE:NIFTY 50', 'NSE:NIFTY BANK', 'BSE:SENSEX', 'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY MID SELECT', 'BSE:BANKEX'],
  'INDEX-OPT': ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'],
  'STOCK-FUT': ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'WIPRO', 'AXISBANK', 'LT', 'BAJFINANCE'],
  'STOCK-OPT': ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'WIPRO', 'AXISBANK'],
  'NSE-EQ': ['NSE:RELIANCE', 'NSE:TCS', 'NSE:INFY', 'NSE:HDFCBANK', 'NSE:ICICIBANK', 'NSE:SBIN', 'NSE:WIPRO', 'NSE:AXISBANK', 'NSE:LT', 'NSE:BAJFINANCE', 'NSE:MARUTI', 'NSE:TATAMOTORS'],
  'MCX-FUT': ['MCX:GOLD', 'MCX:SILVER', 'MCX:CRUDEOIL', 'MCX:NATURALGAS', 'MCX:COPPER', 'MCX:ZINC'],
  'MCX-OPT': ['GOLDM', 'GOLD', 'SILVERM', 'SILVER', 'CRUDEOILM', 'CRUDEOIL', 'NATGASMINI', 'NATURALGAS'],
  'COMEX': ['GC=F', 'SI=F', 'CL=F', 'NG=F', 'HG=F', 'PL=F', 'PA=F'],
  'CRYPTO': ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'BNBUSDT', 'SOLUSDT', 'ADAUSDT', 'DOTUSDT', 'MATICUSDT', 'LINKUSDT', 'AVAXUSDT'],
  'FOREX': ['EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'USDCAD=X', 'USDCHF=X', 'NZDUSD=X'],
  'US-EQ': ['AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NFLX', 'AMD', 'INTC', 'SPY', 'QQQ', 'DIA', 'ES=F', 'NQ=F', 'YM=F'],
};
export const LOG_ROWS = 10;

// ─── Types ──────────────────────────────────────────────────────────────────
export type ToastState = { message: string; type: 'success' | 'error' } | null;
export type WatchlistItem = { id: string; symbol: string; tab: string };
export type ActLogItem = {
  id: string; type: string; time: string; by: string; by_id: string | null; by_client_id: string | null; target: string; target_id: string | null; target_client_id: string | null;
  symbol: string | null; qty: number | null; price: number | null;
  reason: string | null; ip: string;
  // New fields
  original_price: number | null;
  margin_used: number | null;
  buffer: number | null;
  brokerage_value: number | null;
  brokerage_mode: 'per_crore' | 'per_lot' | null;
  trade_mode: 'carry' | 'intraday' | null;
  edited_by: string | null;
  edited_at: string | null;
  edit_remark: string | null;
};

export type UserListItem = {
  id: string;
  client_id?: string;
  email: string;
  full_name: string | null;
  role: string;
  active: boolean;
  balance: number;
  phone: string | null;
  parent_id: string | null;
  scheduled_delete_at: string | null;
  segments: string[] | null;
  read_only: boolean;
  demo_user: boolean;
  intraday_sq_off: boolean;
  auto_sqoff: number;
  sqoff_method: string;
  created_at: string;
  settlement_amount?: number;
  trading_mode?: string;
  mode_locked_until?: string | null;
  template_id?: string | null;
  openPnl?: number;
  m2m?: number;
  weeklyPnl?: number;
  marginUsed?: number;
};

export type PositionItem = {
  id: string; user_id: string; profiles?: { email: string; client_id?: string; full_name?: string } | null;
  symbol: string; side: 'BUY' | 'SELL'; pnl: number;
  qty_open: number; qty_total: number; avg_price: number; entry_price: number;
  ltp: number | null; exit_price: number | null; duration_seconds: number;
  brokerage: number; sl: number | null; tp: number | null;
  entry_time: string; exit_time: string | null; settlement: string | null;
  status: 'open' | 'active' | 'closed';
  closed_by?: string | null;
  settlement_amount?: number | null;
};

export type Position = {
  id: string;
  user_id: string;
  client_id?: string;
  user_name?: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  pnl: number;
  qty: string;       // e.g. "4/4" open, "0/5" closed
  avgPrice: number;
  entry: number;
  ltp?: number;      // open/active
  exit?: number;     // closed
  duration: string;
  brokerage: number;
  slTp: string;
  entryTime: string;
  exitTime?: string;
  settlement?: string;
  status: 'open' | 'active' | 'closed';
  closed_by?: string;
  settlementAmount?: number;
};

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}h ${m}m ${s}s`;
}

export function positionItemToPosition(item: PositionItem): Position {
  let currentPnl = item.pnl || 0;
  if ((item.status === 'open' || item.status === 'active') && item.ltp != null) {
      const unrealized = item.side === 'BUY' 
          ? (item.ltp - item.avg_price) * item.qty_open 
          : (item.avg_price - item.ltp) * item.qty_open;
      currentPnl += unrealized;
  }

  const durationSec = (item.status === 'open' || item.status === 'active')
    ? Math.max(0, Math.floor((Date.now() - new Date(item.entry_time).getTime()) / 1000))
    : (item.duration_seconds || 0);

  return {
    id: item.id,
    user_id: item.user_id,
    client_id: item.profiles?.client_id || undefined,
    user_name: item.profiles?.full_name || item.profiles?.email || undefined,
    symbol: item.symbol,
    side: item.side,
    pnl: currentPnl,
    qty: `${item.qty_open}/${item.qty_total}`,
    avgPrice: item.avg_price,
    entry: item.entry_price,
    ltp: item.ltp ?? undefined,
    exit: item.exit_price ?? undefined,
    duration: formatDuration(durationSec),
    brokerage: item.brokerage,
    slTp: `${item.sl ?? '–'} / ${item.tp ?? '–'}`,
    entryTime: item.entry_time ? new Date(item.entry_time).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : '',
    exitTime: item.exit_time ? new Date(item.exit_time).toLocaleString('en-IN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true }) : undefined,
    settlement: item.settlement ?? undefined,
    status: item.status,
    closed_by: item.closed_by || undefined,
    settlementAmount: item.settlement_amount ? Math.abs(item.settlement_amount) : undefined,
  };
}
export function downloadCSV(data: Record<string, unknown>[], filename: string) {
  if (data.length === 0) return;
  const headers = Object.keys(data[0]).join(',');
  const rows = data.map(obj => 
    Object.values(obj).map(val => 
      typeof val === 'string' ? `"${val.replace(/"/g, '""')}"` : val
    ).join(',')
  );
  const csvContent = [headers, ...rows].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

// ─── API helper ───────────────────────────────────────────────────────────────
export async function apiCall(
  path: string,
  options: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData.session?.access_token ?? '';
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(options.headers ?? {}),
      },
    });
    
    // Handle empty responses (like 204 No Content)
    if (res.status === 204) {
      return { ok: res.ok, status: res.status, data: null };
    }
    
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    console.warn(`apiCall error [${path}]:`, err);
    return { ok: false, status: 500, data: { error: 'Network or Authentication Error' } };
  }
}

// ─── UI Components ────────────────────────────────────────────────────────────
export function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 3000);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        background: toast.type === 'success' ? '#1a7f4b' : '#b91c1c',
        color: '#fff',
        padding: '12px 20px',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        minWidth: 240,
        maxWidth: 400,
      }}
    >
      <span style={{ flex: 1, fontSize: '0.875rem' }}>{toast.message}</span>
      <button
        onClick={onDismiss}
        style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '1rem', lineHeight: 1 }}
      >
        ✕
      </button>
    </div>
  );
}

export function SkeletonLine({ width = '100%', height = 14, style = {} }: { width?: string | number; height?: number; style?: React.CSSProperties }) {
  return (
    <div style={{
      width,
      height,
      borderRadius: 6,
      background: 'linear-gradient(90deg, #21262d 25%, #30363d 50%, #21262d 75%)',
      backgroundSize: '200% 100%',
      animation: 'adm-skeleton-shimmer 1.4s infinite',
      ...style,
    }} />
  );
}

export function SkeletonCard({ rows = 3, style = {} }: { rows?: number; style?: React.CSSProperties }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #21262d', borderRadius: 10, padding: '16px', display: 'flex', flexDirection: 'column', gap: 10, ...style }}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine key={i} width={i === 0 ? '60%' : i % 2 === 0 ? '80%' : '90%'} />
      ))}
    </div>
  );
}

export function SkeletonTable({ cols = 4, rows = 5 }: { cols?: number; rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, padding: '8px 0' }}>
        {Array.from({ length: cols }).map((_, i) => <SkeletonLine key={i} height={12} width="70%" />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 8, padding: '10px 12px', background: '#161b22', borderRadius: 8 }}>
          {Array.from({ length: cols }).map((_, c) => <SkeletonLine key={c} height={13} width={c === 0 ? '85%' : '60%'} />)}
        </div>
      ))}
    </div>
  );
}

export function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
  loading,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}) {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 9998,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: 12,
          padding: '24px',
          maxWidth: 360,
          width: '90%',
        }}
        onClick={e => e.stopPropagation()}
      >
        <div style={{ color: '#e6edf3', fontSize: '0.95rem', marginBottom: 20 }}>{message}</div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
          <button className="adm-sheet-cancel" onClick={onCancel} disabled={loading}>
            Cancel
          </button>
          <button className="adm-btn-primary" onClick={onConfirm} disabled={loading}>
            {loading ? 'Confirming…' : 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DeletionBanner({ scheduledDeleteAt }: { scheduledDeleteAt: string }) {
  const hoursRemaining = Math.max(
    0,
    Math.round((new Date(scheduledDeleteAt).getTime() - Date.now()) / (1000 * 60 * 60)),
  );
  return (
    <div
      style={{
        background: '#7c2d12',
        color: '#fca5a5',
        borderRadius: 6,
        padding: '8px 12px',
        fontSize: '0.8rem',
        marginTop: 8,
      }}
    >
      Scheduled for deletion in {hoursRemaining} hours — log in to cancel
    </div>
  );
}
