'use client';
import React, { useState, useEffect, useCallback } from 'react';
import { apiCall, Toast, ToastState } from '../AdminUtils';
import { AccountTemplate } from '../TemplatesPage';
import { SegmentSettingsType, SegmentRow, defaultSeg, SegmentBlock } from './TemplateSegmentBlock';

const ALL_SEGMENTS = ['INDEX-FUT', 'STOCK-OPT', 'NSE-EQ', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

type FormTab = 'profile' | 'segments' | 'scalper';

interface TemplateFormProps {
  template?: AccountTemplate;
  onBack: () => void;
  onSaved: () => void;
  isDemoMode?: boolean;
  isBroker?: boolean;
}

export default function TemplateForm({ template, onBack, onSaved, isDemoMode, isBroker }: TemplateFormProps) {
  const isEdit = !!template;
  const [activeTab, setActiveTab] = useState<FormTab>('profile');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  // Profile fields
  const [name, setName] = useState(template?.name ?? '');
  const [description, setDescription] = useState(template?.description ?? '');
  const [isDefault, setIsDefault] = useState(template?.is_default ?? false);
  const [segments, setSegments] = useState<string[]>(template?.segments ?? []);
  const [readOnly, setReadOnly] = useState(template?.read_only ?? false);
  const [demoUser, setDemoUser] = useState(template ? template.demo_user : (isDemoMode ?? false));
  const [intradaySqOff, setIntradaySqOff] = useState(template?.intraday_sq_off ?? false);
  const [autoSqoff, setAutoSqoff] = useState(String(template?.auto_sqoff ?? 90));
  const [showcaseAutoSqoff, setShowcaseAutoSqoff] = useState(String((template as any)?.showcase_auto_sqoff ?? 85));
  const [sqoffMethod, setSqoffMethod] = useState(template?.sqoff_method ?? 'Credit');
  const [tradingMode, setTradingMode] = useState(template?.trading_mode ?? 'normal');
  const [carryRolloverDay, setCarryRolloverDay] = useState((template as any)?.carry_rollover_day ?? 'Sunday');
  const [carryRolloverTime, setCarryRolloverTime] = useState((template as any)?.carry_rollover_time ?? '23:59');

  // Segment settings
  const [segSettings, setSegSettings] = useState<Record<string, SegmentSettingsType>>({});
  const [scalperSettings, setScalerSettings] = useState<Record<string, SegmentSettingsType>>({});
  const [expandedSegments, setExpandedSegments] = useState<Record<string, boolean>>({});
  const [loadingSegs, setLoadingSegs] = useState(false);

  const segBlocks = ALL_SEGMENTS.flatMap(s => [`${s}-BUY`, `${s}-SELL`]);

  const rowToSettings = (row: SegmentRow): SegmentSettingsType => ({
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
    holdingType: row.holding_type,
    entryBuffer: String(row.entry_buffer),
    bidBuffer: String(row.bid_buffer ?? 0),
    exitBuffer: String(row.exit_buffer),
    tradeAllowed: row.trade_allowed,
    topLimit: String(row.top_limit ?? 0),
    minLimit: String(row.min_limit ?? 0),
    useCustomCalc: row.use_custom_calc ?? false,
    exitPriceMode: row.exit_price_mode ?? 'BID_ASK',
  });

  const loadSegments = useCallback(async () => {
    if (!template?.id) return;
    setLoadingSegs(true);
    const baseUrl = isBroker ? `/api/broker/templates/${template.id}/segments` : `/api/admin/templates/${template.id}/segments`;
    const [normalRes, scalperRes] = await Promise.all([
      apiCall(`${baseUrl}?mode=normal`, { method: 'GET' }),
      apiCall(`${baseUrl}?mode=scalper`, { method: 'GET' }),
    ]);
    setLoadingSegs(false);
    if (normalRes.ok) {
      const map: Record<string, SegmentSettingsType> = {};
      for (const row of normalRes.data as SegmentRow[]) {
        map[`${row.segment}-${row.side}`] = rowToSettings(row);
      }
      setSegSettings(map);
    }
    if (scalperRes.ok) {
      const map: Record<string, SegmentSettingsType> = {};
      for (const row of scalperRes.data as SegmentRow[]) {
        map[`${row.segment}-${row.side}`] = rowToSettings(row);
      }
      setScalerSettings(map);
    }
  }, [template?.id]);

  useEffect(() => { loadSegments(); }, [loadSegments]);

  const settingsToRows = (settings: Record<string, SegmentSettingsType>, templateId: string) => {
    return segBlocks.map(name => {
      const parts = name.split('-');
      const side = parts[parts.length - 1] as 'BUY' | 'SELL';
      const segment = parts.slice(0, parts.length - 1).join('-');
      const s = settings[name] ?? defaultSeg();
      return {
        template_id: templateId,
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
        holding_type: s.holdingType,
        entry_buffer: Number(s.entryBuffer),
        bid_buffer: Number(s.bidBuffer || 0),
        exit_buffer: Number(s.exitBuffer),
        trade_allowed: s.tradeAllowed,
        top_limit: Number(s.topLimit ?? 0),
        min_limit: Number(s.minLimit ?? 0),
        use_custom_calc: s.useCustomCalc,
        exit_price_mode: s.exitPriceMode ?? 'BID_ASK',
      };
    });
  };

  const handleSave = async () => {
    if (!name.trim()) {
      setToast({ message: 'Template name is required', type: 'error' });
      return;
    }

    setSaving(true);

    const profilePayload = {
      name: name.trim(),
      description: description.trim() || null,
      is_default: isDefault,
      segments: segments.length > 0 ? segments : null,
      read_only: readOnly,
      demo_user: demoUser,
      intraday_sq_off: intradaySqOff,
      auto_sqoff: Number(autoSqoff),
      showcase_auto_sqoff: Number(showcaseAutoSqoff),
      sqoff_method: sqoffMethod,
      trading_mode: tradingMode,
      carry_rollover_day: carryRolloverDay,
      carry_rollover_time: carryRolloverTime,
    };

    let templateId = template?.id;

    try {
      const url = isBroker ? `/api/broker/templates${isEdit ? `/${templateId}` : ''}` : `/api/admin/templates${isEdit ? `/${templateId}` : ''}`;
      const res = await apiCall(url, {
        method: isEdit ? 'PATCH' : 'POST',
        body: JSON.stringify(profilePayload),
      });

      if (!res.ok) throw new Error((res.data as any)?.error || 'Failed to save template');
      const savedTemplate = res.data as AccountTemplate;

      const segRows = settingsToRows(segSettings, savedTemplate.id);
      const scalperRows = settingsToRows(scalperSettings, savedTemplate.id);

      const segUrl = isBroker ? `/api/broker/templates/${savedTemplate.id}/segments` : `/api/admin/templates/${savedTemplate.id}/segments`;
      
      const [nRes, sRes] = await Promise.all([
        apiCall(`${segUrl}?mode=normal`, { method: 'POST', body: JSON.stringify(segRows) }),
        apiCall(`${segUrl}?mode=scalper`, { method: 'POST', body: JSON.stringify(scalperRows) }),
      ]);

      if (!nRes.ok || !sRes.ok) throw new Error('Template profile saved but segment settings failed');

      setToast({ message: `Template "${name}" ${isEdit ? 'updated' : 'created'} successfully`, type: 'success' });
      setTimeout(onSaved, 800);
    } catch (e: any) {
      setToast({ message: e.message, type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const toggleSegment = (seg: string) => {
    setSegments(prev =>
      prev.includes(seg) ? prev.filter(s => s !== seg) : [...prev, seg]
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)' }}>
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '10px 16px', borderBottom: '1px solid #30363d', flexShrink: 0,
      }}>
        <button
          onClick={onBack}
          style={{ background: 'transparent', border: 'none', color: '#8b949e', cursor: 'pointer', fontSize: '1.1rem', padding: '4px 8px' }}
        >
          ←
        </button>
        <span style={{ color: '#e6edf3', fontWeight: 700, fontSize: '1rem' }}>
          {isEdit ? `Edit: ${template.name}` : 'New Template'}
        </span>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '8px 12px', borderBottom: '1px solid #30363d', flexShrink: 0 }}>
        {(['profile', 'segments', 'scalper'] as FormTab[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '6px 12px', borderRadius: 6, cursor: 'pointer',
              background: activeTab === tab ? '#1f2937' : 'transparent',
              border: activeTab === tab ? '1px solid #374151' : '1px solid transparent',
              color: activeTab === tab ? '#e6edf3' : '#8b949e',
              fontSize: '12px', fontWeight: activeTab === tab ? 600 : 400,
            }}
          >
            {tab === 'profile' ? 'Profile Settings' : tab === 'segments' ? 'Normal Segments' : 'Scalper Segments'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', background: '#0d1117' }}>
        {activeTab === 'profile' && (
          <ProfileTab
            name={name} setName={setName}
            description={description} setDescription={setDescription}
            isDefault={isDefault} setIsDefault={setIsDefault}
            segments={segments} toggleSegment={toggleSegment}
            readOnly={readOnly} setReadOnly={setReadOnly}
            demoUser={demoUser} setDemoUser={setDemoUser}
            intradaySqOff={intradaySqOff} setIntradaySqOff={setIntradaySqOff}
            autoSqoff={autoSqoff} setAutoSqoff={setAutoSqoff}
            showcaseAutoSqoff={showcaseAutoSqoff} setShowcaseAutoSqoff={setShowcaseAutoSqoff}
            sqoffMethod={sqoffMethod} setSqoffMethod={setSqoffMethod}
            tradingMode={tradingMode} setTradingMode={setTradingMode}
            carryRolloverDay={carryRolloverDay} setCarryRolloverDay={setCarryRolloverDay}
            carryRolloverTime={carryRolloverTime} setCarryRolloverTime={setCarryRolloverTime}
          />
        )}

        {activeTab === 'segments' && (
          <SegmentsTab
            segBlocks={segBlocks}
            settings={segSettings}
            setSettings={setSegSettings}
            expandedSegments={expandedSegments}
            setExpandedSegments={setExpandedSegments}
            loading={loadingSegs}
            onCopyToOtherMode={() => {
              if (confirm('Copy all Normal settings to Scalper?')) {
                setScalerSettings(segSettings);
                setToast({ message: 'Settings copied to Scalper (click Save to apply)', type: 'success' });
              }
            }}
          />
        )}

        {activeTab === 'scalper' && (
          <SegmentsTab
            segBlocks={segBlocks}
            settings={scalperSettings}
            setSettings={setScalerSettings}
            expandedSegments={expandedSegments}
            setExpandedSegments={setExpandedSegments}
            loading={loadingSegs}
            isScalper
            onCopyToOtherMode={() => {
              if (confirm('Copy all Scalper settings to Normal?')) {
                setSegSettings(scalperSettings);
                setToast({ message: 'Settings copied to Normal (click Save to apply)', type: 'success' });
              }
            }}
          />
        )}
      </div>

      {/* Save footer */}
      <div style={{
        padding: '12px 16px', borderTop: '1px solid #30363d',
        display: 'flex', justifyContent: 'flex-end', gap: 10, flexShrink: 0,
        background: '#0d1117',
      }}>
        <button
          onClick={onBack}
          style={{ background: '#21262d', border: '1px solid #30363d', color: '#c9d1d9', padding: '8px 20px', borderRadius: 6, cursor: 'pointer', fontSize: '13px' }}
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="adm-btn-primary"
          style={{ padding: '8px 20px', fontSize: '13px', borderRadius: 6, opacity: saving ? 0.6 : 1 }}
        >
          {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Template'}
        </button>
      </div>
    </div>
  );
}

function ProfileTab({
  name, setName, description, setDescription,
  isDefault, setIsDefault, segments, toggleSegment,
  readOnly, setReadOnly, demoUser, setDemoUser,
  intradaySqOff, setIntradaySqOff, autoSqoff, setAutoSqoff,
  showcaseAutoSqoff, setShowcaseAutoSqoff,
  sqoffMethod, setSqoffMethod, tradingMode, setTradingMode,
  carryRolloverDay, setCarryRolloverDay, carryRolloverTime, setCarryRolloverTime,
}: {
  name: string; setName: (v: string) => void;
  description: string; setDescription: (v: string) => void;
  isDefault: boolean; setIsDefault: (v: boolean) => void;
  segments: string[]; toggleSegment: (s: string) => void;
  readOnly: boolean; setReadOnly: (v: boolean) => void;
  demoUser: boolean; setDemoUser: (v: boolean) => void;
  intradaySqOff: boolean; setIntradaySqOff: (v: boolean) => void;
  autoSqoff: string; setAutoSqoff: (v: string) => void;
  showcaseAutoSqoff: string; setShowcaseAutoSqoff: (v: string) => void;
  sqoffMethod: string; setSqoffMethod: (v: string) => void;
  tradingMode: string; setTradingMode: (v: string) => void;
  carryRolloverDay: string; setCarryRolloverDay: (v: string) => void;
  carryRolloverTime: string; setCarryRolloverTime: (v: string) => void;
}) {
  const ALL_SEGS = ['INDEX-FUT', 'STOCK-OPT', 'NSE-EQ', 'COMEX', 'INDEX-OPT', 'MCX-FUT', 'CRYPTO', 'STOCK-FUT', 'MCX-OPT', 'FOREX', 'US-EQ'];

  return (
    <div style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Field label="Template Name *">
        <input className="adm-upd-input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Standard Broker" />
      </Field>

      <Field label="Description">
        <textarea
          className="adm-upd-input"
          value={description}
          onChange={e => setDescription(e.target.value)}
          placeholder="Optional description"
          rows={2}
          style={{ resize: 'vertical' }}
        />
      </Field>

      <Field label="Trading Mode">
        <select className="adm-upd-input adm-upd-select" value={tradingMode} onChange={e => setTradingMode(e.target.value)}>
          <option value="normal">Normal</option>
          <option value="scalper">Scalper</option>
        </select>
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <Field label="Base Auto Sq-Off (%)">
          <input className="adm-upd-input" type="number" value={autoSqoff} onChange={e => setAutoSqoff(e.target.value)} />
        </Field>
        <Field label="Showcase Sq-Off (%)">
          <input className="adm-upd-input" type="number" value={showcaseAutoSqoff} onChange={e => setShowcaseAutoSqoff(e.target.value)} />
        </Field>
        <Field label="Sq-Off Method">
          <select className="adm-upd-input adm-upd-select" value={sqoffMethod} onChange={e => setSqoffMethod(e.target.value)}>
            <option value="Credit">Credit</option>
            <option value="Debit">Debit</option>
          </select>
        </Field>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Field label="Carry Rollover Day">
          <select className="adm-upd-input adm-upd-select" value={carryRolloverDay} onChange={e => setCarryRolloverDay(e.target.value)}>
            <option value="Monday">Monday</option>
            <option value="Tuesday">Tuesday</option>
            <option value="Wednesday">Wednesday</option>
            <option value="Thursday">Thursday</option>
            <option value="Friday">Friday</option>
            <option value="Saturday">Saturday</option>
            <option value="Sunday">Sunday</option>
          </select>
        </Field>
        <Field label="Carry Rollover Time (HH:MM)">
          <input className="adm-upd-input" type="time" value={carryRolloverTime} onChange={e => setCarryRolloverTime(e.target.value)} />
        </Field>
      </div>

      {/* Toggle fields */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <ToggleRow label="Set as Default Template" value={isDefault} onChange={setIsDefault} />
        <ToggleRow label="Read Only" value={readOnly} onChange={setReadOnly} />
        <ToggleRow label="Demo User" value={demoUser} onChange={setDemoUser} />
        <ToggleRow label="Intraday Square-Off" value={intradaySqOff} onChange={setIntradaySqOff} />
      </div>

      {/* Segments selector */}
      <div>
        <label style={{ color: '#c9d1d9', fontSize: '13px', fontWeight: 600, display: 'block', marginBottom: 8 }}>
          Active Segments <span style={{ color: '#8b949e', fontWeight: 400 }}>(select segments to include in this template)</span>
        </label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {ALL_SEGS.map(seg => (
            <button
              key={seg}
              onClick={() => toggleSegment(seg)}
              style={{
                padding: '5px 12px', borderRadius: 20, fontSize: '11px', cursor: 'pointer',
                background: segments.includes(seg) ? '#14532d' : '#21262d',
                border: `1px solid ${segments.includes(seg) ? '#16a34a' : '#30363d'}`,
                color: segments.includes(seg) ? '#86efac' : '#8b949e',
                fontWeight: segments.includes(seg) ? 600 : 400,
              }}
            >
              {seg}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function SegmentsTab({
  segBlocks,
  settings,
  setSettings,
  expandedSegments,
  setExpandedSegments,
  loading,
  isScalper = false,
  onCopyToOtherMode,
}: {
  segBlocks: string[];
  settings: Record<string, SegmentSettingsType>;
  setSettings: (fn: (prev: Record<string, SegmentSettingsType>) => Record<string, SegmentSettingsType>) => void;
  expandedSegments: Record<string, boolean>;
  setExpandedSegments: (fn: (prev: Record<string, boolean>) => Record<string, boolean>) => void;
  loading: boolean;
  isScalper?: boolean;
  onCopyToOtherMode?: () => void;
}) {
  if (loading) return <div style={{ color: '#8b949e', padding: 20 }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
        <button
          onClick={() => setExpandedSegments(() => Object.fromEntries(segBlocks.map(b => [b, true])))}
          className="adm-upd-copy-btn"
          style={{ fontSize: '11px', padding: '5px 12px' }}
        >Expand All</button>
        <button
          onClick={() => setExpandedSegments(() => ({}))}
          className="adm-upd-copy-btn"
          style={{ fontSize: '11px', padding: '5px 12px' }}
        >Collapse All</button>

        {onCopyToOtherMode && (
          <button
            onClick={onCopyToOtherMode}
            className="adm-btn-primary"
            style={{ fontSize: '11px', padding: '5px 12px', background: '#3b82f6', border: 'none', marginLeft: 'auto' }}
          >
            Copy to {isScalper ? 'Normal' : 'Scalper'}
          </button>
        )}
      </div>

      {segBlocks.map(name => (
        <SegmentBlock
          key={name}
          name={name}
          value={settings[name] ?? defaultSeg(isScalper)}
          onChange={(k: keyof SegmentSettingsType, v: string | boolean) => setSettings(prev => ({
            ...prev,
            [name]: { ...(prev[name] ?? defaultSeg(isScalper)), [k]: v },
          }))}
          availableBlocks={segBlocks}
          onPerformCopy={(sourceName: string) => setSettings(prev => ({
            ...prev,
            [name]: { ...(prev[sourceName] ?? defaultSeg(isScalper)) },
          }))}
          isExpanded={!!expandedSegments[name]}
          onToggleExpand={() => setExpandedSegments(prev => ({ ...prev, [name]: !prev[name] }))}
        />
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="adm-upd-field">
      <label className="adm-upd-label">{label}</label>
      {children}
    </div>
  );
}

function ToggleRow({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <span style={{ color: '#c9d1d9', fontSize: '13px' }}>{label}</span>
      <div
        className={`adm-toggle ${value ? 'on' : ''}`}
        style={value ? { background: '#14b8a6' } : {}}
        onClick={() => onChange(!value)}
      >
        <div className="adm-toggle-thumb" style={{ background: '#fff' }} />
      </div>
    </div>
  );
}
