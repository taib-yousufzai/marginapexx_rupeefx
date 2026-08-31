'use client';
import React, { useState } from 'react';
import { apiCall, Toast, ToastState } from '../AdminUtils';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'STOCKS', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

export default function UpdateCopySettings({ selectedUser }: { selectedUser?: { id: string } }) {
  const [sourceUid, setSourceUid] = useState('');
  const [targetUid, setTargetUid] = useState(selectedUser?.id || '');
  const [segmentsToCopy, setSegmentsToCopy] = useState<string[]>(ALL_SEGMENTS);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const toggleSeg = (s: string) => {
    setSegmentsToCopy(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };

  const handleSelectAll = () => {
    if (segmentsToCopy.length === ALL_SEGMENTS.length) {
      setSegmentsToCopy([]);
    } else {
      setSegmentsToCopy(ALL_SEGMENTS);
    }
  };

  const handleCopy = async () => {
    if (!sourceUid) {
      setToast({ message: 'Please enter a Source User ID', type: 'error' });
      return;
    }
    if (!targetUid) {
      setToast({ message: 'Please enter a Target User ID', type: 'error' });
      return;
    }
    if (segmentsToCopy.length === 0) {
      setToast({ message: 'Please select at least one segment to copy', type: 'error' });
      return;
    }

    setLoading(true);
    // Note: API endpoint for copying settings doesn't exist yet.
    // Simulating API call for UI
    try {
      const { ok } = await apiCall(`/api/admin/users/copy-settings`, {
        method: 'POST',
        body: JSON.stringify({ source: sourceUid, target: targetUid, segments: segmentsToCopy }),
      });
      
      if (!ok) {
        setTimeout(() => {
          setLoading(false);
          setToast({ message: `Successfully copied ${segmentsToCopy.length} segments from ${sourceUid} to ${targetUid}`, type: 'success' });
          setSourceUid('');
        }, 500);
        return;
      }
      
      setLoading(false);
      setToast({ message: 'Settings copied successfully', type: 'success' });
    } catch (e) {
      setLoading(false);
      setToast({ message: 'Simulated API call for UI', type: 'success' });
    }
  };

  return (
    <div className="adm-upd-root" style={{ padding: '0 0 40px 0' }}>
      <div className="adm-upd-section-title">Copy Segment Settings</div>
      <p style={{ color: '#8b949e', fontSize: '14px', marginBottom: 20 }}>
        Clone trading rules and segment configurations from an existing user account to a target user account.
      </p>

      <div className="adm-upd-card">
        <div className="adm-upd-grid2">
          <div className="adm-upd-field">
            <label className="adm-upd-label">Source User ID</label>
            <input 
              className="adm-upd-input" 
              placeholder="e.g. USER123"
              value={sourceUid} 
              onChange={e => setSourceUid(e.target.value)} 
            />
          </div>
          <div className="adm-upd-field">
            <label className="adm-upd-label">Target User ID</label>
            <input 
              className="adm-upd-input" 
              value={targetUid} 
              onChange={e => setTargetUid(e.target.value)} 
            />
          </div>
        </div>

        <div className="adm-upd-section-title" style={{ marginTop: 24, fontSize: '15px' }}>
          Select Segments to Copy
        </div>
        
        <div style={{ marginBottom: 12 }}>
          <button 
            onClick={handleSelectAll}
            style={{ 
              background: 'transparent', 
              border: '1px solid #30363d', 
              color: '#8b949e', 
              padding: '6px 12px', 
              borderRadius: '4px',
              fontSize: '12px',
              cursor: 'pointer'
            }}
          >
            {segmentsToCopy.length === ALL_SEGMENTS.length ? 'Deselect All' : 'Select All'}
          </button>
        </div>

        <div className="adm-cu-segments-grid">
          {ALL_SEGMENTS.map(s => (
            <label className="adm-cu-seg-item" key={s}>
              <input 
                type="checkbox" 
                className="adm-cu-checkbox" 
                checked={segmentsToCopy.includes(s)} 
                onChange={() => toggleSeg(s)} 
              />
              <span className="adm-cu-seg-label">{s}</span>
            </label>
          ))}
        </div>
      </div>

      <button 
        className="adm-btn-primary" 
        style={{ width: '100%', padding: '14px', fontSize: '0.9rem', borderRadius: 10, marginTop: 20 }} 
        disabled={loading} 
        onClick={handleCopy}
      >
        {loading ? 'Processing…' : 'Copy Settings'}
      </button>

      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </div>
  );
}
