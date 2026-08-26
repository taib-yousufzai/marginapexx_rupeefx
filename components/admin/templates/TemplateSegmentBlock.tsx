'use client';
import React, { useState } from 'react';

// ─── Types ────────────────────────────────────────────────────────────────────

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
  exitBuffer: string; tradeAllowed: boolean;
  topLimit: string; minLimit: string;
  useCustomCalc: boolean;
  bidBuffer: string;
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
  holding_type: string;
  bid_buffer?: number;
  entry_buffer: number;
  exit_buffer: number;
  trade_allowed: boolean;
  top_limit: number;
  min_limit: number;
  use_custom_calc?: boolean;
  exit_price_mode?: 'BID_ASK' | 'LTP';
}

export const defaultSeg = (isScalper = false): SegmentSettingsType => ({
  commissionType: 'Per Crore', commissionValue: isScalper ? '8500' : '4500',
  carryCommissionType: 'Per Crore', carryCommissionValue: isScalper ? '8500' : '4500',
  gttCommissionType: 'Per Trade', gttCommissionValue: '10',
  profitHoldSec: isScalper ? '15' : '120', loss_hold_sec: '0',
  strikeRange: '0', maxLot: '50',
  maxOrderLot: '50', intradayLeverage: '50',
  intradayType: 'Multiplier',
  holdingLeverage: '5', entryBuffer: '0',
  holdingType: 'Multiplier',
  bidBuffer: '0',
  exitBuffer: '0', tradeAllowed: true,
  topLimit: '0', minLimit: '0',
  useCustomCalc: false,
  exitPriceMode: 'BID_ASK',
});

// ─── SegmentBlock ─────────────────────────────────────────────────────────────

export function SegmentBlock({
  name,
  value,
  onChange,
  availableBlocks,
  onPerformCopy,
  isExpanded,
  onToggleExpand,
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
    <div className="adm-upd-seg-block" style={{ marginBottom: 20, position: 'relative' }}>
      <div
        className="adm-upd-seg-header"
        onClick={onToggleExpand}
        style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}
      >
        <span className="adm-upd-seg-name" style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
          {name}
          <i className={`fas fa-chevron-${isExpanded ? 'up' : 'down'}`} style={{ fontSize: '0.8rem', color: '#8b949e' }} />
        </span>

        <div style={{ position: 'relative' }} onClick={e => e.stopPropagation()}>
          <button
            className="adm-upd-copy-btn"
            onClick={e => { e.preventDefault(); setShowCopyDropdown(!showCopyDropdown); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <i className="far fa-copy" /> Copy From
          </button>
          {showCopyDropdown && (
            <div
              style={{
                position: 'absolute', right: 0, top: 'calc(100% + 5px)',
                background: '#161b22', border: '1px solid #30363d', borderRadius: 8,
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 10,
                minWidth: 160, maxHeight: 200, overflowY: 'auto', padding: '6px 0',
              }}
              onMouseLeave={() => setShowCopyDropdown(false)}
            >
              <div style={{ padding: '6px 12px', fontSize: 11, color: '#8b949e', borderBottom: '1px solid #30363d', fontWeight: 600 }}>
                Select Segment
              </div>
              {availableBlocks.filter(b => b !== name).map(b => (
                <button
                  key={b}
                  onClick={() => { onPerformCopy(b); setShowCopyDropdown(false); }}
                  style={{
                    width: '100%', padding: '8px 12px', background: 'transparent', border: 'none',
                    color: '#c9d1d9', textAlign: 'left', fontSize: 12, cursor: 'pointer',
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = '#21262d'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                >
                  {b}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {isExpanded && (
        <>
          <div className="adm-upd-grid2" style={{ marginTop: 15 }}>
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

          <div className="adm-upd-grid2">
            <div />
            <div className="adm-upd-field">
              <label className="adm-upd-label">Intraday Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.intradayType} onChange={e => upd('intradayType', e.target.value)}>
                <option>Multiplier</option><option value="%">%</option><option>Fixed</option>
              </select>
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                {value.intradayType === '%' ? 'Req Funds = (Qty × Price) × (Leverage / 100)' : value.intradayType === 'Fixed' ? 'Req Funds = Lots × Leverage — fixed ₹ per lot' : 'Req Funds = (Qty × Price) ÷ Leverage'}
              </span>
            </div>
          </div>

          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Holding Leverage</label>
              <input className="adm-upd-input" type="number" value={value.holdingLeverage} onChange={e => upd('holdingLeverage', e.target.value)} />
            </div>
            <div className="adm-upd-field">
            </div>
          </div>

          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Holding Type</label>
              <select className="adm-upd-input adm-upd-select" value={value.holdingType} onChange={e => upd('holdingType', e.target.value)}>
                <option>Multiplier</option><option value="%">%</option><option>Fixed</option>
              </select>
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '4px', display: 'block', lineHeight: '1.4' }}>
                {value.holdingType === '%' ? 'Req Funds = (Qty × Price) × (Leverage / 100)' : value.holdingType === 'Fixed' ? 'Req Funds = Lots × Leverage — fixed ₹ per lot' : 'Req Funds = (Qty × Price) ÷ Leverage'}
              </span>
            </div>
            <div />
          </div>

          <div className="adm-upd-grid3" style={{ alignItems: 'flex-start' }}>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Entry Buffer (%)</label>
              <input className="adm-upd-input" type="number" step="0.001" placeholder="e.g. 0.3" value={value.entryBuffer} onChange={e => upd('entryBuffer', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>0.3 = 0.3% | 1.0 = 1% | 0.1 = 0.1%</span>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Bid Buffer (%)</label>
              <input className="adm-upd-input" type="number" step="0.001" placeholder="e.g. 0.3" value={value.bidBuffer} onChange={e => upd('bidBuffer', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>0.3 = 0.3% | 1.0 = 1% | 0.1 = 0.1%</span>
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Exit Buffer (%)</label>
              <input className="adm-upd-input" type="number" step="0.001" placeholder="e.g. 0.17" value={value.exitBuffer} onChange={e => upd('exitBuffer', e.target.value)} />
              <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>0.17 = 0.17% | 1.0 = 1% | 0.1 = 0.1%</span>
            </div>
          </div>

          <div className="adm-upd-grid2" style={{ marginTop: 12 }}>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Execution Price Mode</label>
              <select
                className="adm-upd-input adm-upd-select"
                value={value.exitPriceMode ?? 'BID_ASK'}
                onChange={e => upd('exitPriceMode', e.target.value as 'BID_ASK' | 'LTP')}
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

          {name.includes('CRYPTO') && (
            <div className="adm-upd-grid2" style={{ marginTop: '15px' }}>
              <div className="adm-upd-field" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <label className="adm-upd-label" style={{ marginBottom: 0 }}>Use Custom Fill Calculation</label>
                <label className="adm-upd-toggle">
                  <input type="checkbox" checked={value.useCustomCalc} onChange={e => upd('useCustomCalc', e.target.checked)} />
                  <span className="adm-upd-slider"></span>
                </label>
              </div>
              <div />
            </div>
          )}

          <div className="adm-upd-grid2">
            <div className="adm-upd-field">
              <label className="adm-upd-label">Top Price Limit (%)</label>
              <input className="adm-upd-input" type="number" step="0.1" value={value.topLimit} onChange={e => upd('topLimit', e.target.value)} />
            </div>
            <div className="adm-upd-field">
              <label className="adm-upd-label">Min Price Limit (%)</label>
              <input className="adm-upd-input" type="number" step="0.1" value={value.minLimit} onChange={e => upd('minLimit', e.target.value)} />
            </div>
          </div>

          <div className="adm-upd-grid2" style={{ alignItems: 'flex-start' }}>
            <div className="adm-upd-toggle-item" style={{ marginTop: 2 }}>
              <span className="adm-upd-label">Trade Allowed</span>
              <div style={{ display: 'flex', alignItems: 'center', height: 40, marginTop: 4 }}>
                <div
                  className={`adm-toggle ${value.tradeAllowed ? 'on' : ''}`}
                  style={value.tradeAllowed ? { background: '#14b8a6' } : {}}
                  onClick={() => upd('tradeAllowed', !value.tradeAllowed)}
                >
                  <div className="adm-toggle-thumb" style={{ background: '#fff' }} />
                </div>
              </div>
            </div>
            <div />
          </div>
        </>
      )}
    </div>
  );
}
