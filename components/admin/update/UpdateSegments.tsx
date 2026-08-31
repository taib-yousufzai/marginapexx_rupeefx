'use client';
import React, { useState, useEffect } from 'react';
import { signOut } from '@/lib/auth';
import { apiCall, Toast, ToastState, UserListItem } from '../AdminUtils';
import AnimatedLoader from '@/components/AnimatedLoader';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'STOCKS', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

export type SegmentSettingsType = {
  commissionType: string; commissionValue: string;
  carryCommissionType: string; carryCommissionValue: string;
  gttCommissionType: string; gttCommissionValue: string;
  profitHoldSec: string; loss_hold_sec: string;
  strikeRange: string; maxLot: string;
  maxOrderLot: string; intradayLeverage: string;
  intradayType: string;
  holdingLeverage: string; entryBuffer: string;
  holdingType: string;
  bidBuffer: string;
  exitBuffer: string; tradeAllowed: boolean;
  topLimit: string;
  minLimit: string;
  useCustomCalc: boolean;
  exitPriceMode: 'BID_ASK' | 'LTP';
};

export interface SegmentRow {
  segment: string;
  side: string;
  commission_type: string;
  commission_value: number;
  carry_commission_type: string;
  carry_commission_value: number;
  gtt_commission_type: string;
  gtt_commission_value: number;
  profit_hold_sec: number;
  loss_hold_sec: number;
  strike_range: number;
  max_lot: number;
  max_order_lot: number;
  intraday_leverage: number;
  intraday_type: string;
  holding_leverage: number;
  entry_buffer: number;
  holding_type: string;
  use_custom_calc?: boolean;
  bid_buffer: number;
  exit_buffer: number;
  trade_allowed: boolean;
  top_limit: number;
  min_limit: number;
  exit_price_mode?: 'BID_ASK' | 'LTP';
}

const defaultSeg = (): SegmentSettingsType => ({
  commissionType: 'Per Crore', commissionValue: '4500',
  carryCommissionType: 'Per Crore', carryCommissionValue: '4500',
  gttCommissionType: 'Per Trade', gttCommissionValue: '10',
  profitHoldSec: '120', loss_hold_sec: '0',
  strikeRange: '0', maxLot: '50',
  maxOrderLot: '50', intradayLeverage: '50',
  intradayType: 'Multiplier',
  holdingLeverage: '5', holdingType: 'Multiplier',
  entryBuffer: '0', exitBuffer: '0',
  bidBuffer: '0', tradeAllowed: true,
  topLimit: '0', minLimit: '0',
  useCustomCalc: false,
  exitPriceMode: 'BID_ASK'
});

function SegmentBlock({ 
  name, 
  value, 
  onChange,
  availableBlocks,
  onPerformCopy,
  isExpanded,
  onToggleExpand
}: { 
  name: string; 
  value: SegmentSettingsType; 
  onChange: (k: keyof SegmentSettingsType, v: string | boolean) => void;
  availableBlocks: string[];
  onPerformCopy: (sourceName: string) => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const [showCopyDropdown, setShowCopyDropdown] = useState(false);
  const upd = (k: keyof SegmentSettingsType, v: string | boolean) => onChange(k, v);

  return (
    <div className="adm-upd-seg-block" style={{ marginBottom: '20px', position: 'relative' }}>
      <div 
        className="adm-upd-seg-header" 
        onClick={onToggleExpand}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}
      >
        <span className="adm-upd-seg-name" style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
          {name}
          <i className={`fas fa-chevron-${isExpanded ? 'up' : 'down'}`} style={{ fontSize: '0.8rem', color: '#8b949e' }}></i>
        </span>
        
        {/* Copy From Button */}
        <div style={{ position: 'relative' }} onClick={(e) => e.stopPropagation()}>
          <button 
            className="adm-upd-copy-btn" 
            onClick={(e) => { e.preventDefault(); setShowCopyDropdown(!showCopyDropdown); }}
            style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <i className="far fa-copy"></i> Copy From
          </button>
          
          {showCopyDropdown && (
            <div 
              style={{
                position: 'absolute',
                right: 0,
                top: 'calc(100% + 5px)',
                background: '#161b22',
                border: '1px solid #30363d',
                borderRadius: '8px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                zIndex: 10,
                minWidth: '160px',
                maxHeight: '200px',
                overflowY: 'auto',
                padding: '6px 0'
              }}
              onMouseLeave={() => setShowCopyDropdown(false)}
            >
              <div style={{ padding: '6px 12px', fontSize: '11px', color: '#8b949e', borderBottom: '1px solid #30363d', fontWeight: 600 }}>Select Segment</div>
              {availableBlocks.filter(b => b !== name).length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: '12px', color: '#8b949e' }}>No other segments</div>
              ) : (
                availableBlocks.filter(b => b !== name).map(b => (
                  <button
                    key={b}
                    onClick={() => {
                      onPerformCopy(b);
                      setShowCopyDropdown(false);
                    }}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      background: 'transparent',
                      border: 'none',
                      color: '#c9d1d9',
                      textAlign: 'left',
                      fontSize: '12px',
                      cursor: 'pointer',
                      transition: 'background 0.2s',
                    }}
                    onMouseEnter={e => e.currentTarget.style.background = '#21262d'}
                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                  >
                    {b}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      </div>

      {isExpanded && (
        <>
          {/* Row 1: Commission Type & Value */}
          <div className="adm-upd-grid2" style={{ marginTop: '15px' }}>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Intraday Commission Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.commissionType} onChange={e => upd('commissionType', e.target.value)}>
                <option>Per Crore</option><option>Per Lot</option><option>Per Trade</option>
              </select>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Intraday Commission Value</label>
              <input className="adm-upd-input" type="number" value={value.commissionValue} onChange={e => upd('commissionValue', e.target.value)} />
            </div>
          </div>

          {/* Row 1a: Carry Commission Type & Value */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Carry Commission Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.carryCommissionType} onChange={e => upd('carryCommissionType', e.target.value)}>
                <option>Per Crore</option><option>Per Lot</option><option>Per Trade</option>
              </select>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Carry Commission Value</label>
              <input className="adm-upd-input" type="number" value={value.carryCommissionValue} onChange={e => upd('carryCommissionValue', e.target.value)} />
            </div>
          </div>

          {/* Row 1b: GTT Commission Type & Value */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">GTT Commission Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.gttCommissionType} onChange={e => upd('gttCommissionType', e.target.value)}>
                <option>Per Crore</option><option>Per Lot</option><option>Per Trade</option>
              </select>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">GTT Commission Value</label>
              <input className="adm-upd-input" type="number" value={value.gttCommissionValue} onChange={e => upd('gttCommissionValue', e.target.value)} />
            </div>
          </div>

          {/* Row 2: Profit Hold Sec & Loss Hold Sec */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Profit Hold Sec</label>
              <input className="adm-upd-input" type="number" value={value.profitHoldSec} onChange={e => upd('profitHoldSec', e.target.value)} />
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Loss Hold Sec</label>
              <input className="adm-upd-input" type="number" value={value.loss_hold_sec} onChange={e => upd('loss_hold_sec', e.target.value)} />
            </div>
          </div>

          {/* Row 3: Strike Range & Max Lot */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Strike Range</label>
              <input className="adm-upd-input" type="number" value={value.strikeRange} onChange={e => upd('strikeRange', e.target.value)} />
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Max Lot</label>
              <input className="adm-upd-input" type="number" value={value.maxLot} onChange={e => upd('maxLot', e.target.value)} />
            </div>
          </div>

          {/* Row 4: Max Order Lot & Intraday Leverage */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Max Order Lot</label>
              <input className="adm-upd-input" type="number" value={value.maxOrderLot} onChange={e => upd('maxOrderLot', e.target.value)} />
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Intraday Leverage</label>
              <input className="adm-upd-input" type="number" value={value.intradayLeverage} onChange={e => upd('intradayLeverage', e.target.value)} />
            </div>
          </div>

          {/* Row 5: Intraday Type on Right (Left side blank) */}
          <div className="adm-upd-grid2">
            <div></div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Intraday Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.intradayType} onChange={e => upd('intradayType', e.target.value)}>
                <option>Multiplier</option><option value="%">%</option><option>Fixed</option>
              </select>
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                {value.intradayType === '%'
                  ? 'Req Funds = (Qty × Price) × (Leverage / 100)'
                  : value.intradayType === 'Fixed'
                  ? 'Req Funds = Lots × Leverage  — fixed ₹ per lot (ideal for option selling)'
                  : 'Req Funds = (Qty × Price) ÷ Leverage'}
              </span>
            </div>
          </div>

          {/* Row 6: Holding Leverage & Entry Buffer */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Holding Leverage</label>
              <input className="adm-upd-input" type="number" value={value.holdingLeverage} onChange={e => upd('holdingLeverage', e.target.value)} />
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Entry Buffer</label>
              <input className="adm-upd-input" type="number" step="0.0001" placeholder="e.g. 0.3" value={value.entryBuffer} onChange={e => upd('entryBuffer', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>% format: 0.3 = 0.3% | 1.0 = 1% | 0.1 = 0.1%</span>
            </div>
          </div>

          {/* Row 7: Holding Type on Left, Bid Buffer on Right */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Holding Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.holdingType} onChange={e => upd('holdingType', e.target.value)}>
                <option>Multiplier</option><option value="%">%</option><option>Fixed</option>
              </select>
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                {value.holdingType === '%'
                  ? 'Req Funds = (Qty × Price) × (Leverage / 100)'
                  : value.holdingType === 'Fixed'
                  ? 'Req Funds = Lots × Leverage  — fixed ₹ per lot (ideal for option selling)'
                  : 'Req Funds = (Qty × Price) ÷ Leverage'}
              </span>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Bid Buffer</label>
              <input className="adm-upd-input" type="number" step="0.0001" placeholder="e.g. 0.3" value={value.bidBuffer} onChange={e => upd('bidBuffer', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>% format: 0.3 = 0.3% | 1.0 = 1% | 0.1 = 0.1%</span>
            </div>
          </div>

          {/* Row 8: Exit Buffer & Trade Allowed */}
          <div className="adm-upd-grid2" style={{ alignItems: 'flex-start' }}>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Exit Buffer</label>
              <input className="adm-upd-input" type="number" step="0.0001" placeholder="e.g. 0.17" value={value.exitBuffer} onChange={e => upd('exitBuffer', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>% format: 0.17 = 0.17% | 1.0 = 1% | 0.1 = 0.1%</span>
            </div>
            <div className="adm-upd-toggle-item" style={{ marginTop: 2 }}>
              <span className="adm-upd-label">Trade Allowed</span>
              <div style={{ display: 'flex', alignItems: 'center', height: '40px', marginTop: '4px' }}>
                <div 
                  className={`adm-toggle ${value.tradeAllowed ? 'on' : ''}`} 
                  style={value.tradeAllowed ? { background: '#14b8a6' } : {}}
                  onClick={() => upd('tradeAllowed', !value.tradeAllowed)}
                >
                  <div className="adm-toggle-thumb" style={{ background: '#fff' }} />
                </div>
              </div>
            </div>
          </div>

          {/* Row 9: Top Limit & Min Limit (Price check thresholds) */}
          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Top Price Limit (%)</label>
              <input className="adm-upd-input" type="number" step="0.1" value={value.topLimit} onChange={e => upd('topLimit', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                {name.endsWith('-SELL') 
                  ? 'Max Sell Limit Price = LTP - Top Limit% (0% = sell at LTP or lower only)'
                  : 'Max Buy Limit Price = LTP + Top Limit% (0% = buy at LTP or lower only)'}
              </span>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Min Price Limit (%)</label>
              <input className="adm-upd-input" type="number" step="0.1" value={value.minLimit} onChange={e => upd('minLimit', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                {name.endsWith('-SELL')
                  ? 'Min Sell Limit Price = LTP - Min Limit% (0% = disabled)'
                  : 'Min Buy Limit Price = LTP - Min Limit% (0% = disabled)'}
              </span>
            </div>
          </div>

          {/* Row 10: Price Execution Mode (BID_ASK vs LTP) */}
          <div className="adm-upd-grid2" style={{ marginTop: '12px' }}>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Execution Price Mode</label>
              <select 
                className="adm-upd-input adm-upd-select" 
                value={value.exitPriceMode ?? 'BID_ASK'} 
                onChange={e => upd('exitPriceMode', e.target.value)}
              >
                <option value="BID_ASK">BID / ASK Spread</option>
                <option value="LTP">LTP (Raw Price)</option>
              </select>
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                BID_ASK: Entries & Exits use BID/ASK spread multipliers.<br />
                LTP: Purchases & Exits execute relative to raw LTP.
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function UpdateSegments({ selectedUser }: { selectedUser: { id: string } }) {
  const uid = selectedUser.id;
  
  const [segments, setSegments] = useState<string[]>([]);
  const [segSettings, setSegSettings] = useState<Record<string, SegmentSettingsType>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [segmentMode, setSegmentMode] = useState<'normal' | 'scalper'>('normal');
  const [expandedMenu, setExpandedMenu] = useState<'normal' | 'scalper' | null>(null);
  const [expandedSegments, setExpandedSegments] = useState<Record<string, boolean>>({});

  const rowToSegSettings = (row: SegmentRow): SegmentSettingsType => ({
    commissionType: row.commission_type,
    commissionValue: String(row.commission_value),
    carryCommissionType: row.carry_commission_type ?? 'Per Crore',
    carryCommissionValue: String(row.carry_commission_value ?? 4500),
    gttCommissionType: row.gtt_commission_type ?? 'Per Trade',
    gttCommissionValue: String(row.gtt_commission_value ?? 10),
    profitHoldSec: String(row.profit_hold_sec),
    loss_hold_sec: String(row.loss_hold_sec),
    strikeRange: String(row.strike_range),
    maxLot: String(row.max_lot),
    maxOrderLot: String(row.max_order_lot),
    intradayLeverage: String(row.intraday_leverage),
    intradayType: row.intraday_type,
    holdingLeverage: String(row.holding_leverage),
    entryBuffer: String(row.entry_buffer),
    holdingType: row.holding_type,
    bidBuffer: String(row.bid_buffer ?? 0),
    exitBuffer: String(row.exit_buffer),
    tradeAllowed: row.trade_allowed,
    topLimit: String(row.top_limit ?? 0),
    minLimit: String(row.min_limit ?? 0),
    useCustomCalc: row.use_custom_calc ?? false,
    exitPriceMode: row.exit_price_mode ?? 'BID_ASK',
  });

  useEffect(() => {
    if (!uid) return;
    
    setLoading(true);
    const endpoint = segmentMode === 'scalper' ? `/api/admin/users/${uid}/scalper-segments` : `/api/admin/users/${uid}/segments`;

    // Fetch both user segments and the settings
    Promise.all([
      apiCall(`/api/admin/users/${uid}`, { method: 'GET' }),
      apiCall(endpoint, { method: 'GET' })
    ]).then(([userRes, segRes]) => {
      setLoading(false);
      
      if (!userRes.ok || !segRes.ok) {
        setToast({ message: 'Error loading segment settings', type: 'error' });
        return;
      }
      
      const userData = userRes.data as UserListItem;
      setSegments(userData.segments ?? []);
      
      const rows = segRes.data as SegmentRow[];
      const map: Record<string, SegmentSettingsType> = {};
      for (const row of rows) {
        const key = `${row.segment}-${row.side}`;
        map[key] = rowToSegSettings(row);
      }
      setSegSettings(map);
    }).catch(err => {
      setLoading(false);
      setToast({ message: err instanceof Error ? err.message : 'Network error', type: 'error' });
    });
  }, [uid, segmentMode]);

  const segBlocks = ALL_SEGMENTS.flatMap(s => [`${s}-BUY`, `${s}-SELL`]);

  const handleCopySettings = () => {
    localStorage.setItem('copiedSegmentSettings', JSON.stringify(segSettings));
    setToast({ message: 'Settings copied successfully', type: 'success' });
  };

  const handlePasteSettings = () => {
    const saved = localStorage.getItem('copiedSegmentSettings');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSegSettings(parsed);
        setToast({ message: 'Settings pasted successfully. Click Save to apply.', type: 'success' });
      } catch(e) {
        setToast({ message: 'Failed to parse copied settings', type: 'error' });
      }
    } else {
      setToast({ message: 'No copied settings found', type: 'error' });
    }
  };

  const handleCopyToOtherMode = async () => {
    const target = segmentMode === 'scalper' ? 'Normal' : 'Scalper';
    if (!confirm(`Are you sure you want to copy all current settings on this screen to ${target} segments?`)) return;
    
    setSaving(true);
    
    const segRows = segBlocks.map(name => {
      const parts = name.split('-');
      const side = parts[parts.length - 1];
      const segment = parts.slice(0, parts.length - 1).join('-');
      const s = segSettings[name] ?? defaultSeg();
      return {
        user_id: uid,
        segment,
        side,
        commission_type: s.commissionType,
        commission_value: Number(s.commissionValue),
        carry_commission_type: s.carryCommissionType,
        carry_commission_value: Number(s.carryCommissionValue),
        gtt_commission_type: s.gttCommissionType,
        gtt_commission_value: Number(s.gttCommissionValue),
        profit_hold_sec: Number(s.profitHoldSec),
        loss_hold_sec: Number(s.loss_hold_sec),
        strike_range: Number(s.strikeRange),
        max_lot: Number(s.maxLot),
        max_order_lot: Number(s.maxOrderLot),
        intraday_leverage: Number(s.intradayLeverage),
        intraday_type: s.intradayType,
        holding_leverage: Number(s.holdingLeverage),
        entry_buffer: isNaN(parseFloat(s.entryBuffer)) ? 0.3 : parseFloat(s.entryBuffer),
        holding_type: s.holdingType,
        bid_buffer: isNaN(parseFloat(s.bidBuffer)) ? 0.3 : parseFloat(s.bidBuffer),
        exit_buffer: isNaN(parseFloat(s.exitBuffer)) ? 0.17 : parseFloat(s.exitBuffer),
        trade_allowed: s.tradeAllowed,
        top_limit: Number(s.topLimit ?? 0),
        min_limit: Number(s.minLimit ?? 0),
        exit_price_mode: s.exitPriceMode ?? 'BID_ASK',
      };
    });
    
    const endpoint = segmentMode === 'scalper' ? `/api/admin/users/${uid}/segments` : `/api/admin/users/${uid}/scalper-segments`;
    const segRes = await apiCall(endpoint, {
      method: 'POST',
      body: JSON.stringify(segRows),
    });
    
    setSaving(false);
    if (segRes.status === 401) { signOut(); return; }
    if (segRes.status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
    if (!segRes.ok) { setToast({ message: 'Server Error', type: 'error' }); return; }

    setToast({ message: `Successfully copied to ${target}!`, type: 'success' });
  };


  const handleSave = async () => {
    setSaving(true);
    
    const segRows = segBlocks.map(name => {
      const parts = name.split('-');
      const side = parts[parts.length - 1];
      const segment = parts.slice(0, parts.length - 1).join('-');
      const s = segSettings[name] ?? defaultSeg();
      return {
        user_id: uid,
        segment,
        side,
        commission_type: s.commissionType,
        commission_value: Number(s.commissionValue),
        carry_commission_type: s.carryCommissionType,
        carry_commission_value: Number(s.carryCommissionValue),
        gtt_commission_type: s.gttCommissionType,
        gtt_commission_value: Number(s.gttCommissionValue),
        profit_hold_sec: Number(s.profitHoldSec),
        loss_hold_sec: Number(s.loss_hold_sec),
        strike_range: Number(s.strikeRange),
        max_lot: Number(s.maxLot),
        max_order_lot: Number(s.maxOrderLot),
        intraday_leverage: Number(s.intradayLeverage),
        intraday_type: s.intradayType,
        holding_leverage: Number(s.holdingLeverage),
        entry_buffer: isNaN(parseFloat(s.entryBuffer)) ? 0.3 : parseFloat(s.entryBuffer),
        holding_type: s.holdingType,
        bid_buffer: isNaN(parseFloat(s.bidBuffer)) ? 0.3 : parseFloat(s.bidBuffer),
        exit_buffer: isNaN(parseFloat(s.exitBuffer)) ? 0.17 : parseFloat(s.exitBuffer),
        trade_allowed: s.tradeAllowed,
        top_limit: Number(s.topLimit ?? 0),
        min_limit: Number(s.minLimit ?? 0),
        use_custom_calc: s.useCustomCalc,
        exit_price_mode: s.exitPriceMode ?? 'BID_ASK',
      };
    });
    
    const endpoint = segmentMode === 'scalper' ? `/api/admin/users/${uid}/scalper-segments` : `/api/admin/users/${uid}/segments`;
    const segRes = await apiCall(endpoint, {
      method: 'POST',
      body: JSON.stringify(segRows),
    });
    
    setSaving(false);
    if (segRes.status === 401) { signOut(); return; }
    if (segRes.status === 403) { setToast({ message: 'Access Denied', type: 'error' }); return; }
    if (!segRes.ok) { setToast({ message: 'Server Error', type: 'error' }); return; }

    setToast({ message: `${segmentMode === 'scalper' ? 'Scalper' : 'Normal'} segment settings saved successfully`, type: 'success' });
  };

  if (loading) return (
    <div style={{ padding: '40px 0', width: '100%' }}>
      <AnimatedLoader text="Loading segments..." fullScreen={false} />
    </div>
  );

  return (
    <div className="adm-upd-root" style={{ padding: '0 0 40px 0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
        <span style={{ fontSize: '1.25rem', fontWeight: 800, color: '#f8fafc' }}>
          {segmentMode === 'scalper' ? 'Scalper Segment Settings' : 'Normal Segment Settings'}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button 
            onClick={handleCopyToOtherMode}
            disabled={saving}
            className="adm-btn-primary"
            style={{ fontSize: '12px', padding: '6px 14px', background: '#3b82f6', border: 'none', opacity: saving ? 0.6 : 1 }}
          >
            Copy to {segmentMode === 'scalper' ? 'Normal' : 'Scalper'}
          </button>
          <i 
            className="fas fa-bars" 
            style={{ color: '#8b949e', fontSize: '1.2rem', cursor: 'pointer' }}
            onClick={() => setShowMenu(true)}
          ></i>
        </div>
      </div>

      {/* Expand / Collapse All Controls */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <button 
          onClick={() => {
            const next: Record<string, boolean> = {};
            segBlocks.forEach(b => next[b] = true);
            setExpandedSegments(next);
          }}
          className="adm-upd-copy-btn"
          style={{ fontSize: '11px', padding: '5px 12px' }}
        >
          Expand All
        </button>
        <button 
          onClick={() => {
            setExpandedSegments({});
          }}
          className="adm-upd-copy-btn"
          style={{ fontSize: '11px', padding: '5px 12px' }}
        >
          Collapse All
        </button>
      </div>

      {showMenu && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 100, display: 'flex', justifyContent: 'flex-end' }}>
          {/* Overlay */}
          <div 
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} 
            onClick={() => setShowMenu(false)}
          />
          
          {/* Sidebar */}
          <div style={{ 
            position: 'relative', 
            width: '280px', 
            background: '#0d1117', 
            borderLeft: '1px solid #30363d',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            boxShadow: '-8px 0 24px rgba(0,0,0,0.5)',
            animation: 'slideInRight 0.2s ease-out'
          }}>
            <div style={{ padding: '16px', borderBottom: '1px solid #30363d', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '1rem', fontWeight: 700, color: '#f8fafc' }}>Select Segment Type</span>
              <button 
                onClick={() => setShowMenu(false)}
                style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '1.2rem', padding: '4px' }}
              >×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%', transition: 'all 0.15s' }}>
                  <button
                    onClick={() => { setSegmentMode('normal'); setShowMenu(false); setToast({ message: 'Normal mode selected', type: 'success' }); }}
                    style={{
                      flex: 1, padding: '14px 20px', background: 'transparent',
                      border: 'none', color: segmentMode === 'normal' ? '#60a5fa' : '#94a3b8', textAlign: 'left', fontSize: '14px', 
                      cursor: 'pointer', fontWeight: 600, letterSpacing: '0.6px'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = segmentMode === 'normal' ? '#60a5fa' : '#f8fafc'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = segmentMode === 'normal' ? '#60a5fa' : '#94a3b8'; }}
                  >
                    NORMAL SEGMENT
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setExpandedMenu(expandedMenu === 'normal' ? null : 'normal'); }}
                    style={{
                      padding: '14px 20px', background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}
                  >
                    <i className={`fas fa-chevron-${expandedMenu === 'normal' ? 'down' : 'left'}`} style={{ fontSize: '12px' }}></i>
                  </button>
                </div>
                {expandedMenu === 'normal' && (
                  <div style={{ padding: '4px 20px 12px 20px', display: 'flex', flexDirection: 'row', gap: '10px' }}>
                    <button 
                      onClick={handleCopySettings}
                      style={{ flex: 1, background: '#3b82f6', border: 'none', borderRadius: '6px', color: '#ffffff', cursor: 'pointer', fontSize: '12px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontWeight: 600, transition: 'background 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
                      onMouseLeave={e => e.currentTarget.style.background = '#3b82f6'}
                    ><i className="far fa-copy"></i> Copy</button>
                    <button 
                      onClick={handlePasteSettings}
                      style={{ flex: 1, background: '#3b82f6', border: 'none', borderRadius: '6px', color: '#ffffff', cursor: 'pointer', fontSize: '12px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontWeight: 600, transition: 'background 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
                      onMouseLeave={e => e.currentTarget.style.background = '#3b82f6'}
                    ><i className="far fa-clipboard"></i> Paste</button>
                  </div>
                )}
              </div>

              <div style={{ height: '1px', background: 'rgba(255,255,255,0.08)', margin: '0 20px' }} />

              <div>
                <div style={{ display: 'flex', alignItems: 'center', width: '100%', transition: 'all 0.15s' }}>
                  <button
                    onClick={() => { setSegmentMode('scalper'); setShowMenu(false); setToast({ message: 'Scalper mode selected', type: 'success' }); }}
                    style={{
                      flex: 1, padding: '14px 20px', background: 'transparent',
                      border: 'none', color: segmentMode === 'scalper' ? '#60a5fa' : '#94a3b8', textAlign: 'left', fontSize: '14px', 
                      cursor: 'pointer', fontWeight: 600, letterSpacing: '0.6px'
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; e.currentTarget.style.color = segmentMode === 'scalper' ? '#60a5fa' : '#f8fafc'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = segmentMode === 'scalper' ? '#60a5fa' : '#94a3b8'; }}
                  >
                    SCALPER SEGMENT
                  </button>
                  <button 
                    onClick={(e) => { e.stopPropagation(); setExpandedMenu(expandedMenu === 'scalper' ? null : 'scalper'); }}
                    style={{
                      padding: '14px 20px', background: 'transparent', border: 'none', color: '#94a3b8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}
                  >
                    <i className={`fas fa-chevron-${expandedMenu === 'scalper' ? 'down' : 'left'}`} style={{ fontSize: '12px' }}></i>
                  </button>
                </div>
                {expandedMenu === 'scalper' && (
                  <div style={{ padding: '4px 20px 12px 20px', display: 'flex', flexDirection: 'row', gap: '10px' }}>
                    <button 
                      onClick={handleCopySettings}
                      style={{ flex: 1, background: '#3b82f6', border: 'none', borderRadius: '6px', color: '#ffffff', cursor: 'pointer', fontSize: '12px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontWeight: 600, transition: 'background 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
                      onMouseLeave={e => e.currentTarget.style.background = '#3b82f6'}
                    ><i className="far fa-copy"></i> Copy</button>
                    <button 
                      onClick={handlePasteSettings}
                      style={{ flex: 1, background: '#3b82f6', border: 'none', borderRadius: '6px', color: '#ffffff', cursor: 'pointer', fontSize: '12px', padding: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontWeight: 600, transition: 'background 0.2s' }}
                      onMouseEnter={e => e.currentTarget.style.background = '#2563eb'}
                      onMouseLeave={e => e.currentTarget.style.background = '#3b82f6'}
                    ><i className="far fa-clipboard"></i> Paste</button>
                  </div>
                )}
              </div>
            </div>
          </div>
          <style>{`
            @keyframes slideInRight {
              from { transform: translateX(100%); }
              to { transform: translateX(0); }
            }
          `}</style>
        </div>
      )}
      
      {segBlocks.map(name => (
        <SegmentBlock 
          key={name} 
          name={name} 
          value={segSettings[name] ?? defaultSeg()} 
          onChange={(k, v) => setSegSettings(prev => ({ ...prev, [name]: { ...(prev[name] ?? defaultSeg()), [k]: v } }))} 
          availableBlocks={segBlocks}
          onPerformCopy={(sourceName) => setSegSettings(prev => ({ ...prev, [name]: { ...(prev[sourceName] ?? defaultSeg()) } }))}
          isExpanded={!!expandedSegments[name]}
          onToggleExpand={() => setExpandedSegments(prev => ({ ...prev, [name]: !prev[name] }))}
        />
      ))}

      <button className="adm-btn-primary" style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10, marginTop: 20 }} disabled={saving} onClick={handleSave}>
        {saving ? 'Saving…' : 'Save Segment Settings'}
      </button>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
