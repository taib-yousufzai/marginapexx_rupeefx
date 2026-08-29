'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { apiCall, Toast, ToastState } from '../AdminUtils';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'NSE-EQ', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

export default function UpdateBlockScripts({ selectedUser }: { selectedUser: { id: string } }) {
  const uid = selectedUser.id;
  const [scriptName, setScriptName] = useState('');
  const [segment, setSegment] = useState('ALL');
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [activeBlocks, setActiveBlocks] = useState<{ symbols: string[], segments: string[] }>({ symbols: [], segments: [] });

  const fetchBlocks = useCallback(async () => {
    try {
      const { ok, data } = await apiCall(`/api/admin/users/${uid}/block-scripts`, { method: 'GET' });
      if (ok) {
        setActiveBlocks(data as { symbols: string[], segments: string[] });
      }
    } catch (e) {
      console.error('Failed to fetch blocks');
    }
  }, [uid]);

  useEffect(() => {
    fetchBlocks();
  }, [fetchBlocks]);

  const handleBlock = async () => {
    if (segment === 'ALL' && !scriptName) {
      setToast({ message: 'Enter a script name to block, or select a segment', type: 'error' });
      return;
    }

    setLoading(true);
    try {
      const { ok, data } = await apiCall(`/api/admin/users/${uid}/block-scripts`, {
        method: 'POST',
        body: JSON.stringify({ 
          segment: segment !== 'ALL' ? segment : undefined, 
          symbol: scriptName || undefined, 
          reason 
        }),
      });
      
      if (!ok) {
        const err = data as { error?: string };
        setToast({ message: err.error || 'Failed to block script', type: 'error' });
      } else {
        setToast({ message: `Successfully applied block rule`, type: 'success' });
        setScriptName('');
        setReason('');
        fetchBlocks();
      }
    } catch (e) {
      setToast({ message: 'Network error blocking script', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const handleUnblock = async (type: 'symbol' | 'segment', value: string) => {
    try {
      const query = type === 'symbol' ? `symbol=${value}` : `segment=${value}`;
      const { ok } = await apiCall(`/api/admin/users/${uid}/block-scripts?${query}`, {
        method: 'DELETE',
      });
      if (ok) {
        setToast({ message: `Unblocked ${value} successfully`, type: 'success' });
        fetchBlocks();
      }
    } catch (e) {
      setToast({ message: 'Failed to unblock', type: 'error' });
    }
  };

  return (
    <div className="adm-upd-root" style={{ padding: '0 0 40px 0' }}>
      <div className="adm-upd-section-title">Block Scripts &amp; Segments</div>
      <p style={{ color: '#8b949e', fontSize: '14px', marginBottom: 20 }}>
        Prevent this user from trading specific instruments or entire segments as a risk control measure.
      </p>

      <div className="adm-upd-card">
        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Segment (or ALL)</label>
            <select className="adm-upd-input adm-upd-select" value={segment} onChange={e => setSegment(e.target.value)}>
              <option value="ALL">-- ALL Segments --</option>
              {ALL_SEGMENTS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Script Name (Leave blank to block segment)</label>
            <input 
              className="adm-upd-input" 
              placeholder="e.g. RELIANCE, CRUDEOIL"
              value={scriptName} 
              onChange={e => setScriptName(e.target.value)} 
            />
          </div>
        </div>

        <div className="adm-upd-field" style={{ marginTop: 16 }}>
          <label className="adm-upd-label">Block Reason (Internal Note)</label>
          <input 
            className="adm-upd-input" 
            placeholder="e.g. High Volatility Risk"
            value={reason} 
            onChange={e => setReason(e.target.value)} 
          />
        </div>
      </div>

      <button 
        className="adm-btn-primary" 
        style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10, marginTop: 20, background: '#da3633' }} 
        disabled={loading} 
        onClick={handleBlock}
      >
        {loading ? 'Processing…' : 'Apply Block Rule'}
      </button>

      <div className="adm-upd-section-title" style={{ marginTop: 32 }}>Active Blocks</div>
      <div className="adm-upd-card" style={{ padding: '16px' }}>
        {(activeBlocks.symbols.length === 0 && activeBlocks.segments.length === 0) ? (
          <div style={{ textAlign: 'center', color: '#8b949e', padding: '10px' }}>No active blocks for this user.</div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {activeBlocks.segments.map(seg => (
              <div key={seg} style={{ display: 'flex', alignItems: 'center', background: '#3b2020', color: '#ff7b72', padding: '6px 12px', borderRadius: '6px', fontSize: '13px', border: '1px solid #6e2e2e' }}>
                <span style={{ marginRight: '8px' }}>Segment: {seg}</span>
                <button onClick={() => handleUnblock('segment', seg)} style={{ background: 'none', border: 'none', color: '#ff7b72', cursor: 'pointer', fontSize: '16px', padding: 0 }}>&times;</button>
              </div>
            ))}
            {activeBlocks.symbols.map(sym => (
              <div key={sym} style={{ display: 'flex', alignItems: 'center', background: '#202a3b', color: '#58a6ff', padding: '6px 12px', borderRadius: '6px', fontSize: '13px', border: '1px solid #2e446e' }}>
                <span style={{ marginRight: '8px' }}>Symbol: {sym}</span>
                <button onClick={() => handleUnblock('symbol', sym)} style={{ background: 'none', border: 'none', color: '#58a6ff', cursor: 'pointer', fontSize: '16px', padding: 0 }}>&times;</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}

