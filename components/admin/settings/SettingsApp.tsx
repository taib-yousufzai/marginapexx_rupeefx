'use client';
import React, { useState, useEffect } from 'react';
import { Toast, ToastState } from '../AdminUtils';

export default function SettingsApp() {
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [globalKillSwitch, setGlobalKillSwitch] = useState(false);
  const [allowNewRegistrations, setAllowNewRegistrations] = useState(true);
  const [exitPriceMode, setExitPriceMode] = useState<'BID_ASK' | 'LTP'>('BID_ASK');
  const [supportPhone, setSupportPhone] = useState('918796119115');
  const [whatsappCommunityLink, setWhatsappCommunityLink] = useState('');

  const [toast, setToast] = useState<ToastState>(null);
  const [saveLoading, setSaveLoading] = useState(false);
  const [loadingSettings, setLoadingSettings] = useState(true);

  useEffect(() => {
    fetch('/api/admin/platform-settings')
      .then(res => res.json())
      .then(data => {
        if (data.settings?.EXIT_PRICE_MODE) {
          setExitPriceMode(data.settings.EXIT_PRICE_MODE);
        }
        if (data.settings?.MAINTENANCE_MODE !== undefined) {
          setMaintenanceMode(data.settings.MAINTENANCE_MODE === 'true');
        }
        if (data.settings?.GLOBAL_KILL_SWITCH !== undefined) {
          setGlobalKillSwitch(data.settings.GLOBAL_KILL_SWITCH === 'true');
        }
        if (data.settings?.ALLOW_REGISTRATIONS !== undefined) {
          setAllowNewRegistrations(data.settings.ALLOW_REGISTRATIONS === 'true');
        }
        if (data.settings?.SUPPORT_WHATSAPP_NUMBER !== undefined) {
          setSupportPhone(data.settings.SUPPORT_WHATSAPP_NUMBER);
        }
        if (data.settings?.WHATSAPP_COMMUNITY_LINK !== undefined) {
          setWhatsappCommunityLink(data.settings.WHATSAPP_COMMUNITY_LINK);
        }
      })
      .catch(err => console.error('Failed to load platform settings', err))
      .finally(() => setLoadingSettings(false));
  }, []);

  const handleSave = async () => {
    setSaveLoading(true);
    try {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          EXIT_PRICE_MODE: exitPriceMode,
          MAINTENANCE_MODE: String(maintenanceMode),
          GLOBAL_KILL_SWITCH: String(globalKillSwitch),
          ALLOW_REGISTRATIONS: String(allowNewRegistrations),
          SUPPORT_WHATSAPP_NUMBER: supportPhone.trim(),
          WHATSAPP_COMMUNITY_LINK: whatsappCommunityLink.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settings');

      setToast({ message: 'App & Platform settings saved successfully', type: 'success' });
    } catch (err: any) {
      setToast({ message: err.message || 'Error saving settings', type: 'error' });
    } finally {
      setSaveLoading(false);
    }
  };

  return (
    <div className="adm-set-root">
      <Toast toast={toast} onDismiss={() => setToast(null)} />
      
      <div className="adm-mw-header" style={{ marginBottom: 20 }}>
        <div>
          <h2 className="adm-page-title" style={{ margin: 0 }}>App Settings</h2>
          <p style={{ margin: '4px 0 0', color: '#8b949e', fontSize: '13px' }}>Platform-wide toggles and general configurations.</p>
        </div>
      </div>

      <div className="adm-card" style={{ maxWidth: 600, padding: 24 }}>
        <h3 style={{ marginTop: 0, marginBottom: 24, color: '#e6edf3', fontSize: '16px', paddingBottom: 12, borderBottom: '1px solid #30363d' }}>
          Execution & Exit Settings
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 24, marginBottom: 32 }}>
          {/* Position Exit Price Mode */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontWeight: 'bold', color: '#e6edf3', marginBottom: 4 }}>
                Position Exit Price Benchmark
              </div>
              <div style={{ color: '#8b949e', fontSize: '13px', maxWidth: '380px' }}>
                Controls base benchmark for position exits:
                <br />
                • <strong>BID / ASK Spread</strong> (BUY exits at BID price, SELL exits at ASK price).
                <br />
                • <strong>LTP</strong> (Exits execute relative to raw LTP).
              </div>
            </div>
            <select
              value={exitPriceMode}
              onChange={(e) => setExitPriceMode(e.target.value as 'BID_ASK' | 'LTP')}
              disabled={loadingSettings}
              style={{
                backgroundColor: '#161b22',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '6px 12px',
                fontSize: '13px',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <option value="BID_ASK">BID / ASK Spread</option>
              <option value="LTP">LTP (Raw Price)</option>
            </select>
          </div>
        </div>

        <h3 style={{ marginTop: 0, marginBottom: 24, color: '#e6edf3', fontSize: '16px', paddingBottom: 12, borderBottom: '1px solid #30363d' }}>Global Toggles</h3>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          {/* Maintenance Mode */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 'bold', color: '#e6edf3', marginBottom: 4 }}>Maintenance Mode</div>
              <div style={{ color: '#8b949e', fontSize: '13px' }}>Shows a maintenance page to all users. Admins can still log in.</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={maintenanceMode} 
                onChange={(e) => setMaintenanceMode(e.target.checked)}
                style={{ accentColor: '#10b981', width: '20px', height: '20px' }}
              />
            </label>
          </div>

          {/* Global Kill Switch */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 'bold', color: '#f43f5e', marginBottom: 4 }}>Global Trading Kill Switch</div>
              <div style={{ color: '#8b949e', fontSize: '13px' }}>Emergency! Instantly disables all new order placement across the entire platform.</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={globalKillSwitch} 
                onChange={(e) => setGlobalKillSwitch(e.target.checked)}
                style={{ accentColor: '#f43f5e', width: '20px', height: '20px' }}
              />
            </label>
          </div>

          {/* Allow Registrations */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontWeight: 'bold', color: '#e6edf3', marginBottom: 4 }}>Allow New Registrations</div>
              <div style={{ color: '#8b949e', fontSize: '13px' }}>Controls whether new users can sign up via the public registration page.</div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
              <input 
                type="checkbox" 
                checked={allowNewRegistrations} 
                onChange={(e) => setAllowNewRegistrations(e.target.checked)}
                style={{ accentColor: '#10b981', width: '20px', height: '20px' }}
              />
            </label>
          </div>
        </div>

        <h3 style={{ marginTop: 32, marginBottom: 24, color: '#e6edf3', fontSize: '16px', paddingBottom: 12, borderBottom: '1px solid #30363d' }}>
          Support & WhatsApp Settings
        </h3>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Support WhatsApp Number */}
          <div>
            <div style={{ fontWeight: 'bold', color: '#e6edf3', marginBottom: 4 }}>
              Support WhatsApp Number
            </div>
            <div style={{ color: '#8b949e', fontSize: '13px', marginBottom: 8 }}>
              Phone number with country code (e.g. 918796119115) used for 24/7 WhatsApp support links across the app.
            </div>
            <input
              type="text"
              value={supportPhone}
              onChange={(e) => setSupportPhone(e.target.value)}
              placeholder="e.g. 918796119115"
              disabled={loadingSettings}
              style={{
                width: '100%',
                backgroundColor: '#161b22',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '13px',
                boxSizing: 'border-box'
              }}
            />
          </div>

          {/* WhatsApp Community Link */}
          <div>
            <div style={{ fontWeight: 'bold', color: '#e6edf3', marginBottom: 4 }}>
              WhatsApp Community Link
            </div>
            <div style={{ color: '#8b949e', fontSize: '13px', marginBottom: 8 }}>
              Invite link for the Free WhatsApp Community channel shown on the user dashboard.
            </div>
            <input
              type="text"
              value={whatsappCommunityLink}
              onChange={(e) => setWhatsappCommunityLink(e.target.value)}
              placeholder="https://chat.whatsapp.com/..."
              disabled={loadingSettings}
              style={{
                width: '100%',
                backgroundColor: '#161b22',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '8px 12px',
                fontSize: '13px',
                boxSizing: 'border-box'
              }}
            />
          </div>
        </div>
        
        <div style={{ marginTop: 32, paddingTop: 20, borderTop: '1px solid #30363d' }}>
          <button 
            className="adm-btn-primary" 
            onClick={handleSave} 
            disabled={saveLoading || loadingSettings}
          >
            {saveLoading ? 'Saving...' : 'Save App Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
