'use client';
import React, { useState, useEffect } from 'react';
import { Toast, ToastState } from './AdminUtils';

export default function WhatsAppPage() {
  const [supportPhone, setSupportPhone] = useState('');
  const [whatsappCommunityLink, setWhatsappCommunityLink] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const fetchSettings = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/platform-settings');
      const data = await res.json();
      if (res.ok && data.settings) {
        setSupportPhone(data.settings.SUPPORT_WHATSAPP_NUMBER || '');
        setWhatsappCommunityLink(data.settings.WHATSAPP_COMMUNITY_LINK || '');
      }
    } catch (err) {
      console.error('Failed to load WhatsApp settings', err);
      setToast({ message: 'Failed to load WhatsApp settings', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const cleanPhone = supportPhone.trim().replace(/[^\d]/g, '');
      const cleanCommunity = whatsappCommunityLink.trim();

      const res = await fetch('/api/admin/platform-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          SUPPORT_WHATSAPP_NUMBER: cleanPhone,
          WHATSAPP_COMMUNITY_LINK: cleanCommunity,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save WhatsApp settings');

      setSupportPhone(cleanPhone);
      setWhatsappCommunityLink(cleanCommunity);
      setToast({
        message: cleanPhone
          ? 'WhatsApp settings saved and activated for all users'
          : 'WhatsApp settings saved (WhatsApp support is now hidden from users)',
        type: 'success',
      });
    } catch (err: any) {
      setToast({ message: err.message || 'Error saving settings', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    setSupportPhone('');
    setWhatsappCommunityLink('');
    setSaving(true);
    try {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          SUPPORT_WHATSAPP_NUMBER: '',
          WHATSAPP_COMMUNITY_LINK: '',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear WhatsApp settings');

      setToast({
        message: 'WhatsApp configuration cleared. WhatsApp buttons are now hidden for users.',
        type: 'success',
      });
    } catch (err: any) {
      setToast({ message: err.message || 'Error clearing settings', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const hasPhone = Boolean(supportPhone.trim().replace(/[^\d]/g, ''));
  const hasCommunity = Boolean(whatsappCommunityLink.trim());

  return (
    <div className="adm-page">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      <div className="adm-mw-header" style={{ marginBottom: 20 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <h2 className="adm-page-title" style={{ margin: 0 }}>WhatsApp Configuration</h2>
            <span
              style={{
                fontSize: '11px',
                fontWeight: 700,
                padding: '3px 10px',
                borderRadius: '12px',
                background: hasPhone ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                color: hasPhone ? '#10b981' : '#f87171',
                border: `1px solid ${hasPhone ? 'rgba(16, 185, 129, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <i className={`fas fa-${hasPhone ? 'check-circle' : 'eye-slash'}`} />
              {hasPhone ? 'ACTIVE & VISIBLE TO USERS' : 'HIDDEN FROM USERS'}
            </span>
          </div>
          <p style={{ margin: '6px 0 0', color: '#8b949e', fontSize: '13px' }}>
            Manage customer support WhatsApp contact and official community channels.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 20, maxWidth: 680 }}>
        {/* Help Banner */}
        <div
          style={{
            background: 'rgba(56, 189, 248, 0.08)',
            border: '1px solid rgba(56, 189, 248, 0.25)',
            borderRadius: '10px',
            padding: '14px 18px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
          }}
        >
          <i className="fas fa-info-circle" style={{ color: '#38bdf8', fontSize: '18px', marginTop: 2 }} />
          <div style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: '1.5' }}>
            <strong style={{ color: '#ffffff' }}>Automatic Visibility Rule:</strong>
            <br />
            When no WhatsApp number is configured, all WhatsApp support buttons, floating contact cards, and community links across the entire user application (Home, Funds, and Profile) will show nothing and stay completely hidden, matching how unconfigured banking details work.
          </div>
        </div>

        {/* WhatsApp Support Number Card */}
        <div className="adm-card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'rgba(37, 211, 102, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#25D366',
                  fontSize: '18px',
                }}
              >
                <i className="fab fa-whatsapp" />
              </div>
              <div>
                <div style={{ fontWeight: 700, color: '#e6edf3', fontSize: '15px' }}>Support WhatsApp Number</div>
                <div style={{ color: '#8b949e', fontSize: '12px' }}>Direct 24/7 user support chat line</div>
              </div>
            </div>
            {hasPhone && (
              <a
                href={`https://wa.me/${supportPhone.trim().replace(/[^\d]/g, '')}`}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: '12px',
                  color: '#25D366',
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'rgba(37, 211, 102, 0.1)',
                  padding: '5px 10px',
                  borderRadius: '6px',
                  fontWeight: 600,
                }}
              >
                <i className="fas fa-external-link-alt" /> Test Link
              </a>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            <label className="adm-sheet-label" style={{ display: 'block', marginBottom: 6, color: '#8b949e', fontSize: '12px', fontWeight: 600 }}>
              PHONE NUMBER (WITH COUNTRY CODE)
            </label>
            <input
              type="tel"
              className="adm-sheet-input"
              value={supportPhone}
              onChange={(e) => setSupportPhone(e.target.value)}
              placeholder="e.g. 919876543210 (Country code + Number without '+')"
              disabled={loading}
              style={{
                width: '100%',
                backgroundColor: '#161b22',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: '12px', color: '#8b949e', marginTop: 6 }}>
              Format: Include country code without any spaces or symbols (e.g. <code>91</code> for India followed by the 10-digit number).
            </div>
          </div>

          {/* Live Preview Box */}
          <div
            style={{
              padding: '12px 14px',
              borderRadius: '8px',
              background: '#0d1117',
              border: '1px solid #21262d',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
            }}
          >
            <span style={{ color: '#8b949e' }}>Target URL:</span>
            <code style={{ color: hasPhone ? '#58a6ff' : '#6e7681', fontWeight: 600 }}>
              {hasPhone ? `https://wa.me/${supportPhone.trim().replace(/[^\d]/g, '')}` : 'None (Feature Disabled)'}
            </code>
          </div>
        </div>

        {/* WhatsApp Community Link Card */}
        <div className="adm-card" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: 'rgba(56, 189, 248, 0.15)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#38bdf8',
                  fontSize: '18px',
                }}
              >
                <i className="fas fa-users" />
              </div>
              <div>
                <div style={{ fontWeight: 700, color: '#e6edf3', fontSize: '15px' }}>WhatsApp Community / Channel Link</div>
                <div style={{ color: '#8b949e', fontSize: '12px' }}>Optional broadcast group invite link</div>
              </div>
            </div>
            {hasCommunity && (
              <a
                href={whatsappCommunityLink}
                target="_blank"
                rel="noreferrer"
                style={{
                  fontSize: '12px',
                  color: '#38bdf8',
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  background: 'rgba(56, 189, 248, 0.1)',
                  padding: '5px 10px',
                  borderRadius: '6px',
                  fontWeight: 600,
                }}
              >
                <i className="fas fa-external-link-alt" /> Test Link
              </a>
            )}
          </div>

          <div style={{ marginBottom: 18 }}>
            <label className="adm-sheet-label" style={{ display: 'block', marginBottom: 6, color: '#8b949e', fontSize: '12px', fontWeight: 600 }}>
              INVITE LINK URL (OPTIONAL)
            </label>
            <input
              type="url"
              className="adm-sheet-input"
              value={whatsappCommunityLink}
              onChange={(e) => setWhatsappCommunityLink(e.target.value)}
              placeholder="https://chat.whatsapp.com/..."
              disabled={loading}
              style={{
                width: '100%',
                backgroundColor: '#161b22',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '8px',
                padding: '10px 14px',
                fontSize: '14px',
                boxSizing: 'border-box',
              }}
            />
            <div style={{ fontSize: '12px', color: '#8b949e', marginTop: 6 }}>
              Leave blank to hide the community card from the dashboard.
            </div>
          </div>
        </div>

        {/* Action Buttons */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 8 }}>
          <button
            className="adm-btn-primary"
            onClick={handleSave}
            disabled={saving || loading}
            style={{ padding: '10px 24px', fontSize: '14px', fontWeight: 700 }}
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button
            className="adm-btn-danger"
            onClick={handleClear}
            disabled={saving || loading || (!hasPhone && !hasCommunity)}
            style={{ padding: '10px 18px', fontSize: '13px' }}
          >
            Clear &amp; Hide WhatsApp
          </button>
        </div>
      </div>
    </div>
  );
}
