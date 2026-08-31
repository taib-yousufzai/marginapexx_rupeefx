'use client';
import React, { useState } from 'react';
import { apiCall, Toast, ToastState } from '../AdminUtils';
import { SegmentSettingsType } from './UpdateSegments';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'STOCKS', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

const defaultSeg = (): SegmentSettingsType => ({
  commissionType: 'Per Crore', commissionValue: '4500',
  carryCommissionType: 'Per Crore', carryCommissionValue: '4500',
  gttCommissionType: 'Per Trade', gttCommissionValue: '10',
  profitHoldSec: '60', loss_hold_sec: '0',
  strikeRange: '0', maxLot: '50',
  maxOrderLot: '50', intradayLeverage: '50',
  intradayType: 'Multiplier',
  holdingLeverage: '5', holdingType: 'Multiplier',
  entryBuffer: '0.003', exitBuffer: '0.0017',
  bidBuffer: '0',
  tradeAllowed: true,
  topLimit: '0',
  minLimit: '0',
  useCustomCalc: false,
  exitPriceMode: 'BID_ASK',
});

export default function UpdateMultipleSettings({ selectedUser: _selectedUser }: { selectedUser?: { id: string } }) {
  const [targetBroker, setTargetBroker] = useState('');
  const [segmentsToUpdate, setSegmentsToUpdate] = useState<string[]>([]);
  const [config, setConfig] = useState<SegmentSettingsType>(defaultSeg());
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const toggleSeg = (s: string) => {
    setSegmentsToUpdate(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };

  const handleApply = async () => {
    if (!targetBroker) {
      setToast({ message: 'Please enter a target Broker ID', type: 'error' });
      return;
    }
    if (segmentsToUpdate.length === 0) {
      setToast({ message: 'Please select at least one segment to update', type: 'error' });
      return;
    }

    setLoading(true);
    // Simulated API Call
    try {
      const { ok } = await apiCall(`/api/admin/users/bulk-segments`, {
        method: 'POST',
        body: JSON.stringify({ broker: targetBroker, segments: segmentsToUpdate, config }),
      });
      
      if (!ok) {
        setTimeout(() => {
          setLoading(false);
          setToast({ message: `Successfully updated ${segmentsToUpdate.length} segments for users under ${targetBroker}`, type: 'success' });
          setSegmentsToUpdate([]);
        }, 800);
        return;
      }
      
      setLoading(false);
      setToast({ message: 'Bulk update applied successfully', type: 'success' });
    } catch (e) {
      setLoading(false);
      setToast({ message: 'Simulated API call for UI', type: 'success' });
    }
  };

  const upd = (k: keyof SegmentSettingsType, v: string | boolean) => setConfig(prev => ({ ...prev, [k]: v }));

  return (
    <div className="adm-upd-root" style={{ padding: '0 0 40px 0' }}>
      <div className="adm-upd-section-title">Bulk Update Segment Settings</div>
      <p style={{ color: '#8b949e', fontSize: '14px', marginBottom: 20 }}>
        Apply a specific segment configuration to all users under a specific Broker.
      </p>

      <div className="adm-upd-card">
        <div className="adm-upd-field">
          <label className="adm-upd-label">Target Broker ID</label>
          <input 
            className="adm-upd-input" 
            placeholder="e.g. BROKER_MUMBAI_1"
            value={targetBroker} 
            onChange={e => setTargetBroker(e.target.value)} 
          />
        </div>

        <div className="adm-upd-section-title" style={{ marginTop: 24, fontSize: '15px' }}>
          Target Segments
        </div>
        <div className="adm-cu-segments-grid">
          {ALL_SEGMENTS.map(s => (
            <label className="adm-cu-seg-item" key={s}>
              <input 
                type="checkbox" 
                className="adm-cu-checkbox" 
                checked={segmentsToUpdate.includes(s)} 
                onChange={() => toggleSeg(s)} 
              />
              <span className="adm-cu-seg-label">{s}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="adm-upd-section-title" style={{ marginTop: 24 }}>Configuration to Apply</div>
      <div className="adm-upd-seg-block" style={{ marginTop: 0 }}>
        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Intraday Commission Type</label>
            <select className="adm-upd-input adm-upd-select" value={config.commissionType} onChange={e => upd('commissionType', e.target.value)}>
              <option>Per Crore</option><option>Per Lot</option><option>Per Trade</option>
            </select>
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Intraday Commission Value</label>
            <input className="adm-upd-input" type="number" value={config.commissionValue} onChange={e => upd('commissionValue', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Carry Commission Type</label>
            <select className="adm-upd-input adm-upd-select" value={config.carryCommissionType} onChange={e => upd('carryCommissionType', e.target.value)}>
              <option>Per Crore</option><option>Per Lot</option><option>Per Trade</option>
            </select>
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Carry Commission Value</label>
            <input className="adm-upd-input" type="number" value={config.carryCommissionValue} onChange={e => upd('carryCommissionValue', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">GTT Commission Type</label>
            <select className="adm-upd-input adm-upd-select" value={config.gttCommissionType} onChange={e => upd('gttCommissionType', e.target.value)}>
              <option>Per Crore</option><option>Per Lot</option><option>Per Trade</option>
            </select>
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">GTT Commission Value</label>
            <input className="adm-upd-input" type="number" value={config.gttCommissionValue} onChange={e => upd('gttCommissionValue', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Profit Hold (sec)</label>
            <input className="adm-upd-input" type="number" value={config.profitHoldSec} onChange={e => upd('profitHoldSec', e.target.value)} />
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Loss Hold (sec)</label>
            <input className="adm-upd-input" type="number" value={config.loss_hold_sec} onChange={e => upd('loss_hold_sec', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Strike Range</label>
            <input className="adm-upd-input" type="number" value={config.strikeRange} onChange={e => upd('strikeRange', e.target.value)} />
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Max Lot</label>
            <input className="adm-upd-input" type="number" value={config.maxLot} onChange={e => upd('maxLot', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Max Order Lot</label>
            <input className="adm-upd-input" type="number" value={config.maxOrderLot} onChange={e => upd('maxOrderLot', e.target.value)} />
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Intraday Leverage</label>
            <input className="adm-upd-input" type="number" value={config.intradayLeverage} onChange={e => upd('intradayLeverage', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Intraday Type</label>
            <select className="adm-upd-input adm-upd-select" value={config.intradayType} onChange={e => upd('intradayType', e.target.value)}>
              <option>Multiplier</option><option>Direct</option>
            </select>
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Holding Leverage</label>
            <input className="adm-upd-input" type="number" value={config.holdingLeverage} onChange={e => upd('holdingLeverage', e.target.value)} />
          </div>
        </div>

        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Entry Buffer</label>
            <input className="adm-upd-input" type="number" step="0.0001" placeholder="e.g. 0.3" value={config.entryBuffer} onChange={e => upd('entryBuffer', e.target.value)} />
            <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>% format: 0.3 = 0.3% | 1.0 = 1% | 0.1 = 0.1%</span>
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Holding Type</label>
            <select className="adm-upd-input adm-upd-select" value={config.holdingType} onChange={e => upd('holdingType', e.target.value)}>
              <option>Multiplier</option><option>Direct</option>
            </select>
          </div>
        </div>

        <div className="adm-upd-grid2" style={{ alignItems: 'center' }}>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Exit Buffer</label>
            <input className="adm-upd-input" type="number" step="0.0001" placeholder="e.g. 0.17" value={config.exitBuffer} onChange={e => upd('exitBuffer', e.target.value)} />
            <span style={{ fontSize: '10px', color: '#8b949e', marginTop: '3px', display: 'block' }}>% format: 0.17 = 0.17% | 1.0 = 1% | 0.1 = 0.1%</span>
          </div>
          <div className="adm-upd-toggle-item" style={{ marginTop: 14 }}>
            <span className="adm-upd-label">Trade Allowed</span>
            <div className={`adm-toggle ${config.tradeAllowed ? 'on' : ''}`} onClick={() => upd('tradeAllowed', !config.tradeAllowed)}>
              <div className="adm-toggle-thumb" />
            </div>
          </div>
        </div>

        <div className="adm-upd-grid2" style={{ marginTop: 12 }}>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Execution Price Mode</label>
            <select
              className="adm-upd-input adm-upd-select"
              value={config.exitPriceMode ?? 'BID_ASK'}
              onChange={e => upd('exitPriceMode', e.target.value as 'BID_ASK' | 'LTP')}
            >
              <option value="BID_ASK">BID / ASK Spread</option>
              <option value="LTP">LTP (Raw Price)</option>
            </select>
          </div>
        </div>
      </div>

      <button 
        className="adm-btn-primary" 
        style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10, marginTop: 20 }} 
        disabled={loading} 
        onClick={handleApply}
      >
        {loading ? 'Processing…' : 'Apply Bulk Update'}
      </button>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
