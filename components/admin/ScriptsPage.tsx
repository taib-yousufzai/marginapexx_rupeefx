'use client';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiCall, Toast, ToastState } from './AdminUtils';
import { AccountTemplate } from './TemplatesPage';


interface User {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  role: string;
  is_demo?: boolean;
}

interface Instrument {
  id: string;
  tradingsymbol: string;
  name?: string;
  exchange?: string;
  instrument_type?: string;
}

interface TemplateScript {
  id: string;
  symbol: string;
  exchange: string | null;
  created_at: string;
}

const SEGMENT_DEFAULTS: Record<string, string> = {
  'INDEX-FUT':  'NIFTY',
  'INDEX-OPT':  'NIFTY',
  'STOCK-FUT':  'RELIANCE',
  'STOCK-OPT':  'RELIANCE',
  'STOCKS':     'RELIANCE',
  'MCX-FUT':    'GOLD',
  'MCX-OPT':    'GOLD',
  'COMEX':      'GOLD',
  'CRYPTO':     'BTC',
  'FOREX':      'USDINR',
};

const SEGMENTS = [
  'INDEX-FUT', 'INDEX-OPT', 'STOCK-FUT', 'STOCK-OPT',
  'STOCKS', 'MCX-FUT', 'MCX-OPT', 'COMEX', 'CRYPTO', 'FOREX',
];

export default function ScriptsPage() {
  const [templates, setTemplates] = useState<AccountTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<AccountTemplate | null>(null);

  const [templateScripts, setTemplateScripts] = useState<TemplateScript[]>([]);
  const [templateScriptsLoading, setTemplateScriptsLoading] = useState(false);

  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<User[]>([]);

  const [copySearchQuery, setCopySearchQuery] = useState('');
  const [copyDropdownOpen, setCopyDropdownOpen] = useState(false);
  const [selectedCopyUser, setSelectedCopyUser] = useState<User | null>(null);

  const [applyingUsers, setApplyingUsers] = useState(false);
  const [copyingScripts, setCopyingScripts] = useState(false);


  const [activeSegment, setActiveSegment] = useState<string>('INDEX-FUT');
  const [removeMode, setRemoveMode] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);

  // Unified search state
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [instrSearch, setInstrSearch] = useState('');
  const [instrLoading, setInstrLoading] = useState(false);
  const [addingSymbols, setAddingSymbols] = useState<Set<string>>(new Set());

  const [toast, setToast] = useState<ToastState>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load Templates
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    const res = await apiCall('/api/admin/templates', { method: 'GET' });
    setTemplatesLoading(false);
    if (res.ok) {
      const list = res.data as AccountTemplate[];
      setTemplates(list);
      setSelectedTemplate(prev => {
        if (!prev) return list.find(t => t.is_default) ?? (list.length > 0 ? list[0] : null);
        const updated = list.find(t => t.id === prev.id);
        if (updated && JSON.stringify(updated) !== JSON.stringify(prev)) return updated;
        return prev;
      });
    }
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  // Load Template Scripts
  const loadTemplateScripts = useCallback(async (templateId: string) => {
    setTemplateScriptsLoading(true);
    const res = await apiCall(`/api/admin/templates/${templateId}/scripts`, { method: 'GET' });
    setTemplateScriptsLoading(false);
    if (res.ok) {
      setTemplateScripts(res.data as TemplateScript[]);
    }
  }, []);

  useEffect(() => {
    if (selectedTemplate) loadTemplateScripts(selectedTemplate.id);
    else setTemplateScripts([]);
  }, [selectedTemplate, loadTemplateScripts]);

  
  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    const res = await apiCall('/api/admin/users?limit=1000', { method: 'GET' });
    setUsersLoading(false);
    if (res.ok) {
      setAllUsers((res.data as any).data || []);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleApplyToUsers = async () => {
    if (!selectedTemplate || selectedUsers.length === 0) return;
    setApplyingUsers(true);
    const res = await apiCall(`/api/admin/templates/${selectedTemplate.id}/apply`, {
      method: 'POST',
      body: JSON.stringify({ user_ids: selectedUsers.map(u => u.id) })
    });
    setApplyingUsers(false);
    if (res.ok) {
      setToast({ message: `Template successfully applied to ${selectedUsers.length} users`, type: 'success' });
      setSelectedUsers([]);
    } else {
      setToast({ message: (res.data as any).error || 'Failed to apply template', type: 'error' });
    }
  };

  const handleCopyScripts = async () => {
    if (!selectedTemplate || !selectedCopyUser) return;
    setCopyingScripts(true);
    const uRes = await apiCall(`/api/admin/users/${selectedCopyUser.id}`, { method: 'GET' });
    if (uRes.ok && (uRes.data as any).template_id) {
       const sRes = await apiCall(`/api/admin/templates/${(uRes.data as any).template_id}/scripts`, { method: 'GET' });
       if (sRes.ok) {
         const scripts = sRes.data as TemplateScript[];
         if (scripts.length === 0) {
            setToast({ message: 'User template has no scripts to copy', type: 'error' });
            setCopyingScripts(false);
            return;
         }
         const res = await apiCall(`/api/admin/templates/${selectedTemplate.id}/scripts`, {
           method: 'POST',
           body: JSON.stringify({ scripts: scripts.map(s => ({ symbol: s.symbol, exchange: s.exchange })) })
         });
         if (res.ok) {
            setToast({ message: `Successfully copied ${scripts.length} scripts from ${selectedCopyUser.first_name}`, type: 'success' });
            setSelectedCopyUser(null);
            await loadTemplateScripts(selectedTemplate.id);
         } else {
            setToast({ message: 'Failed to save copied scripts', type: 'error' });
         }
       } else {
         setToast({ message: 'Failed to fetch user scripts', type: 'error' });
       }
    } else {
       setToast({ message: 'User does not have an active template to copy from', type: 'error' });
    }
    setCopyingScripts(false);
  };

  // Search Instruments
  const searchInstruments = useCallback(async (segment: string, query: string) => {
    setInstrLoading(true);
    const q = query.length >= 1 ? query : (SEGMENT_DEFAULTS[segment] || 'NIFTY');
    const url = `/api/admin/instruments/search?q=${encodeURIComponent(q)}&tab=${encodeURIComponent(segment)}`;
    const res = await apiCall(url, { method: 'GET' });
    setInstrLoading(false);
    if (res.ok) {
      setInstruments(Array.isArray(res.data) ? res.data : (res.data as any).data || []);
    } else {
      setInstruments([]);
    }
  }, []);

  useEffect(() => {
    searchInstruments(activeSegment, instrSearch);
  }, [activeSegment, searchInstruments]);

  const handleSearchChange = (val: string) => {
    setInstrSearch(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      searchInstruments(activeSegment, val);
    }, 400);
  };

  const handleSetDefault = async () => {
    if (!selectedTemplate) return;
    setSettingDefault(true);
    const res = await apiCall(`/api/admin/templates/${selectedTemplate.id}/set-default`, { method: 'POST' });
    setSettingDefault(false);
    if (res.ok) {
      setToast({ message: `"${selectedTemplate.name}" is now the default template`, type: 'success' });
      await loadTemplates();
    } else {
      const err = res.data as { error?: string };
      setToast({ message: err.error ?? 'Failed to set default', type: 'error' });
    }
  };

  const handleToggleScript = async (sym: string, checked: boolean) => {
    if (!selectedTemplate) return;
    if (removeMode) return; // In remove mode, checking doesn't add it back
    
    setAddingSymbols(prev => new Set(prev).add(sym));

    if (checked) {
      const res = await apiCall(`/api/admin/templates/${selectedTemplate.id}/scripts`, {
        method: 'POST',
        body: JSON.stringify({ symbols: [sym] }),
      });
      if (res.ok) await loadTemplateScripts(selectedTemplate.id);
      else setToast({ message: (res.data as any).error ?? 'Failed to add script', type: 'error' });
    } else {
      const res = await apiCall(`/api/admin/templates/${selectedTemplate.id}/scripts`, {
        method: 'DELETE',
        body: JSON.stringify({ symbols: [sym] }),
      });
      if (res.ok) await loadTemplateScripts(selectedTemplate.id);
      else setToast({ message: (res.data as any).error ?? 'Failed to remove script', type: 'error' });
    }
    
    setAddingSymbols(prev => {
      const n = new Set(prev);
      n.delete(sym);
      return n;
    });
  };

  const handleRemoveSingle = async (symbol: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedTemplate) return;
    const res = await apiCall(`/api/admin/templates/${selectedTemplate.id}/scripts`, {
      method: 'DELETE',
      body: JSON.stringify({ symbols: [symbol] }),
    });
    if (res.ok) {
      await loadTemplateScripts(selectedTemplate.id);
    } else {
      const err = res.data as { error?: string };
      setToast({ message: err.error ?? 'Failed to remove script', type: 'error' });
    }
  };

  // Combine allowed scripts and search results
  // In the old layout, allowed scripts were always shown, and search results were added to the list.
  // Actually, if we search, we filter the allowed scripts OR we show the search results from the DB.
  // We'll show the allowed scripts first, then any additional search results.
  
  const allowedSet = new Set(templateScripts.map(t => t.symbol));
  
  // Filter templateScripts by active segment and search query
  const filteredTemplateScripts = templateScripts.filter(s => {
    if (instrSearch) {
      return s.symbol.toLowerCase().includes(instrSearch.toLowerCase());
    }
    return true; // We don't have exchange/segment easily on templateScripts, but the search results will cover it.
  });

  // Instruments from search that aren't already in the allowed list
  const additionalInstruments = (Array.isArray(instruments) ? instruments : []).filter(i => !allowedSet.has(i.tradingsymbol));

  // Combine them for rendering
  const scriptsToShow = [
    ...filteredTemplateScripts.map(s => ({ symbol: s.symbol, name: s.symbol, allowed: true })),
    ...additionalInstruments.map(i => ({ symbol: i.tradingsymbol, name: i.name || i.tradingsymbol, allowed: false }))
  ];

  return (
    <div className="scripts-mgmt-container dashboard">
      <style dangerouslySetInnerHTML={{ __html: `
      font-family: 'Inter', sans-serif;
      background: #f4f5f7;
      padding: 28px 32px;
      color: #1a1a1a;
    }
    .dashboard { max-width: 1600px; margin:0 auto; }

    :root {
      --dark: #1a1a1a;
      --grey-600: #555555;
      --grey-400: #888888;
      --grey-200: #d0d0d0;
      --grey-100: #eaeaea;
      --grey-50: #f5f5f5;
      --white: #ffffff;
      --shadow: 0 4px 14px rgba(0,0,0,0.02), 0 1px 4px rgba(0,0,0,0.02);
      --shadow-hover: 0 8px 26px rgba(0,0,0,0.04), 0 2px 8px rgba(0,0,0,0.02);
      --radius: 14px;
      --radius-sm: 8px;
      --blue: #2563eb;
      --blue-light: #dbeafe;
      --green: #16a34a;
      --red: #dc2626;
      --maroon: #800000;
      --orange: #ea580c;
    }

    .panel {
      background: var(--white);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      border: 1px solid rgba(0,0,0,0.03);
      padding: 24px 28px;
    }
    .panel:hover { box-shadow: var(--shadow-hover); }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--grey-100);
      flex-wrap: wrap;
      gap: 8px;
    }
    .panel-header h2 {
      font-size: 18px;
      font-weight: 600;
      color: var(--dark);
      letter-spacing: -0.2px;
    }
    .badge-role {
      font-size: 10px;
      background: var(--grey-100);
      color: var(--grey-600);
      padding: 3px 14px;
      font-weight: 600;
      border-radius: 40px;
      letter-spacing: 0.2px;
    }

    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      flex-wrap: wrap;
      gap: 16px;
      padding-bottom: 14px;
      border-bottom: 2px solid var(--dark);
    }
    .header h1 {
      font-weight: 700;
      font-size: 28px;
      letter-spacing: -0.4px;
      color: var(--dark);
    }
    .header h1 span { color: var(--grey-400); font-weight: 300; }

    .super-admin-icon {
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--dark);
      padding: 6px 22px 6px 16px;
      border-radius: 60px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.08);
      border: 1px solid rgba(255,255,255,0.06);
      cursor: default;
    }
    .super-admin-icon .icon-wrapper {
      width: 36px;
      height: 36px;
      background: rgba(255,255,255,0.10);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255,255,255,0.10);
    }
    .super-admin-icon .icon-wrapper svg {
      width: 20px;
      height: 20px;
      fill: white;
      opacity: 0.9;
    }
    .super-admin-icon .label-text {
      color: white;
      font-weight: 600;
      font-size: 14px;
      letter-spacing: 0.2px;
      opacity: 0.95;
    }
    .super-admin-icon .label-text .role-sub {
      font-weight: 400;
      font-size: 10px;
      opacity: 0.6;
      display: block;
      letter-spacing: 0.3px;
      margin-top: -1px;
    }

    .page { display: none; }
    .page.active { display: block; }

    .mobile-reset-container {
      display: none;
      justify-content: flex-end;
      padding: 4px 0 12px 0;
    }
    .mobile-reset-container .mobile-reset-btn {
      padding: 3px 12px;
      border: 1px solid var(--grey-200);
      border-radius: 40px;
      background: transparent;
      font-size: 10px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      color: var(--grey-600);
      cursor: pointer;
      transition: all 0.15s;
    }
    .mobile-reset-container .mobile-reset-btn:hover { background: var(--grey-50); }
    @media (max-width: 768px) { .mobile-reset-container { display: flex; } }

    .segment-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 20px;
      padding-bottom: 16px;
      border-bottom: 1px solid var(--grey-200);
      align-items: center;
    }
    .segment-nav .seg-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 12px 4px 16px;
      border: 1px solid var(--grey-200);
      border-radius: 40px;
      background: var(--white);
      transition: all 0.15s;
      opacity: 1;
    }
    .segment-nav .seg-item.disabled { opacity: 0.5; background: var(--grey-50); }
    .segment-nav .seg-item .seg-tab {
      padding: 4px 0;
      border: none;
      background: transparent;
      font-size: 12px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      color: var(--dark);
      cursor: pointer;
      transition: all 0.15s;
    }
    .segment-nav .seg-item .seg-tab:hover { color: var(--blue); }
    .segment-nav .seg-item .seg-tab.active { color: var(--blue); font-weight: 600; }
    .segment-nav .seg-item .seg-toggle {
      width: 34px;
      height: 18px;
      background: var(--grey-200);
      border-radius: 40px;
      position: relative;
      cursor: pointer;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .segment-nav .seg-item .seg-toggle.active { background: var(--blue); }
    .segment-nav .seg-item .seg-toggle::after {
      content: '';
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      background: white;
      border-radius: 50%;
      transition: transform 0.2s;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .segment-nav .seg-item .seg-toggle.active::after { transform: translateX(16px); }
    .segment-nav .seg-item .seg-toggle.disabled { opacity: 0.5; cursor: not-allowed; }

    .segment-nav .all-scripts-btn {
      padding: 8px 22px;
      border: 1px solid var(--maroon);
      border-radius: 40px;
      background: var(--maroon);
      color: white;
      font-size: 12px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .segment-nav .all-scripts-btn:hover { background: #a00000; border-color: #a00000; }
    
    .segment-nav .remove-mode-toggle {
      padding: 8px 22px;
      border: 1px solid var(--red);
      border-radius: 40px;
      background: transparent;
      color: var(--red);
      font-size: 12px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .segment-nav .remove-mode-toggle:hover { background: #fee2e2; }
    .segment-nav .remove-mode-toggle.active {
      background: var(--red);
      color: white;
    }
    .segment-nav .remove-mode-toggle.active:hover { background: #b91c1c; }
    
    .segment-nav .selected-count {
      font-size: 12px;
      color: var(--grey-600);
      background: var(--grey-100);
      padding: 4px 16px;
      border-radius: 40px;
      white-space: nowrap;
      margin-left: 8px;
    }

    .copy-section {
      margin-bottom: 18px;
      padding: 14px 20px;
      background: var(--grey-50);
      border-radius: var(--radius-sm);
      border: 1px solid var(--grey-200);
      display: flex;
      align-items: center;
      gap: 16px;
      flex-wrap: wrap;
    }
    .copy-section .copy-label { font-size: 12px; font-weight: 600; color: var(--dark); }
    .copy-section .copy-search-wrap {
      position: relative;
      flex: 1;
      min-width: 240px;
    }
    .copy-section .copy-search-wrap input {
      width: 100%;
      padding: 8px 16px;
      border: 1px solid var(--grey-200);
      border-radius: 40px;
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
    }
    .copy-section .copy-search-wrap input:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .copy-section .copy-search-wrap .copy-dropdown {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: white;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      max-height: 200px;
      overflow-y: auto;
      z-index: 100;
      display: none;
      box-shadow: var(--shadow-hover);
    }
    .copy-section .copy-search-wrap .copy-dropdown.show { display: block; }
    .copy-section .copy-search-wrap .copy-dropdown .copy-item {
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      border-bottom: 1px solid var(--grey-100);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .copy-section .copy-search-wrap .copy-dropdown .copy-item:hover { background: var(--grey-50); }
    .copy-section .copy-search-wrap .copy-dropdown .copy-item .user-role { font-size: 10px; color: var(--grey-400); }
    .copy-section .copy-search-wrap .copy-dropdown .empty-msg {
      padding: 10px 14px;
      color: var(--grey-400);
      font-size: 12px;
      text-align: center;
    }
    .copy-section .copy-btn {
      padding: 8px 24px;
      border: 1px solid var(--blue);
      border-radius: 40px;
      background: var(--blue);
      color: white;
      font-size: 13px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
    }
    .copy-section .copy-btn:hover { background: #1d4ed8; }
    .copy-section .copy-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .copy-section .selected-copy-user {
      font-size: 12px;
      color: var(--grey-600);
      background: var(--grey-100);
      padding: 4px 16px;
      border-radius: 40px;
      display: none;
    }
    .copy-section .selected-copy-user.show { display: inline-block; }
    .copy-section .selected-copy-user .clear-copy {
      font-size: 14px;
      color: var(--red);
      cursor: pointer;
      margin-left: 8px;
      font-weight: 700;
    }
    .copy-section .selected-copy-user .clear-copy:hover { color: #b91c1c; }

    .scripts-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
      gap: 8px;
      max-height: 420px;
      overflow-y: auto;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      background: var(--white);
      padding: 16px 18px;
    }
    .scripts-grid .script-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 500;
      color: var(--dark);
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      transition: background 0.1s;
      position: relative;
    }
    .scripts-grid .script-item:hover { background: var(--grey-50); }
    .scripts-grid .script-item .script-checkbox {
      width: 16px;
      height: 16px;
      accent-color: var(--blue);
      cursor: pointer;
      flex-shrink: 0;
    }
    .scripts-grid .script-item .script-checkbox.hidden { display: none; }
    .scripts-grid .script-item .script-name { font-weight: 500; cursor: default; user-select: none; flex: 1; }
    .scripts-grid .script-item .script-symbol { display: none; }
    .scripts-grid .script-item .remove-script-btn {
      color: var(--red);
      cursor: pointer;
      font-weight: 700;
      font-size: 18px;
      padding: 0 4px;
      transition: color 0.15s;
      background: none;
      border: none;
      line-height: 1;
      margin-left: auto;
      flex-shrink: 0;
      display: none;
    }
    .scripts-grid .script-item .remove-script-btn.visible { display: block; }
    .scripts-grid .script-item .remove-script-btn:hover { color: #b91c1c; transform: scale(1.2); }
    .scripts-grid .script-item.remove-mode .script-checkbox { display: none; }
    .scripts-grid .script-item.remove-mode .remove-script-btn { display: block; }
    .scripts-grid .empty-scripts {
      grid-column: 1 / -1;
      text-align: center;
      padding: 32px 0;
      color: var(--grey-400);
      font-size: 14px;
    }

    .default-scripts-row {
      display: flex;
      justify-content: flex-end;
      padding: 12px 0 4px 0;
      border-bottom: 1px solid var(--grey-100);
      margin-bottom: 12px;
    }
    .default-scripts-row .set-default-btn {
      padding: 8px 28px;
      font-size: 13px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      border-radius: 40px;
      cursor: pointer;
      border: 1px solid var(--dark);
      background: var(--dark);
      color: white;
      transition: all 0.15s;
    }
    .default-scripts-row .set-default-btn:hover { background: #2a2a2a; border-color: #2a2a2a; }

    .option-settings {
      margin-top: 20px;
      display: none;
    }
    .option-settings.visible { display: block; }

    .global-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
      margin-bottom: 18px;
      padding: 16px 20px;
      background: var(--white);
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      margin-top: 16px;
    }
    .global-controls .control-group {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      flex: 1 1 0;
      min-width: 180px;
    }
    .global-controls .control-group label {
      font-size: 12px;
      font-weight: 600;
      color: var(--grey-600);
      white-space: nowrap;
    }
    .global-controls .control-group input[type="number"] {
      width: 56px;
      padding: 4px 8px;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
    }
    .global-controls .control-group input[type="number"]:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .global-controls .control-group .apply-global-btn {
      padding: 4px 16px;
      border: 1px solid var(--blue);
      border-radius: 40px;
      background: var(--blue);
      color: white;
      font-size: 12px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
    }
    .global-controls .control-group .apply-global-btn:hover { background: #1d4ed8; }

    .expiry-blocks {
      margin-top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 18px;
    }
    .expiry-block {
      flex: 1 1 0;
      min-width: 200px;
      background: var(--white);
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      padding: 14px 18px;
    }
    .expiry-block .block-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }
    .expiry-block .block-header .block-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--dark);
    }
    .expiry-block .block-header .block-badge {
      font-size: 9px;
      background: var(--grey-100);
      padding: 2px 10px;
      border-radius: 40px;
      color: var(--grey-600);
    }
    .expiry-block .block-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin-top: 2px;
    }
    .expiry-block .block-controls label {
      font-size: 12px;
      font-weight: 500;
      color: var(--grey-600);
      white-space: nowrap;
    }
    .expiry-block .block-controls input[type="number"] {
      width: 64px;
      padding: 4px 8px;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
    }
    .expiry-block .block-controls input[type="number"]:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .expiry-block .block-controls .block-btn {
      padding: 4px 16px;
      border: 1px solid var(--blue);
      border-radius: 40px;
      background: var(--blue);
      color: white;
      font-size: 12px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
    }
    .expiry-block .block-controls .block-btn:hover { background: #1d4ed8; }
    .expiry-block .block-controls .block-btn.remove-btn {
      background: transparent;
      border-color: var(--red);
      color: var(--red);
    }
    .expiry-block .block-controls .block-btn.remove-btn:hover { background: #fee2e2; }

    /* ---- SCRIPT PREVIEW — NO OUTER BOX, JUST THE PREVIEW GRID ---- */
    .script-preview {
      margin-top: 0;
      padding: 0;
      background: transparent;
      border: none;
      border-radius: 0;
    }
    .script-preview .preview-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 12px;
      padding: 0 4px;
    }
    .script-preview .preview-header .preview-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--dark);
    }
    .script-preview .preview-header .preview-badge {
      font-size: 10px;
      background: var(--grey-100);
      padding: 2px 12px;
      border-radius: 40px;
      color: var(--grey-600);
    }
    .script-preview .preview-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
      max-height: 640px;
      overflow-y: auto;
      background: var(--white);
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      padding: 16px 18px;
    }
    .script-preview .preview-item {
      display: flex;
      flex-direction: column;
      gap: 8px;
      font-size: 12px;
      padding: 14px 18px;
      background: var(--grey-50);
      border-radius: var(--radius-sm);
      border: 1px solid var(--grey-100);
      position: relative;
    }
    .script-preview .preview-item .preview-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }
    .script-preview .preview-item .preview-symbol {
      font-weight: 600;
      color: var(--dark);
      min-width: 80px;
    }
    .script-preview .preview-item .preview-label {
      font-size: 10px;
      color: var(--grey-600);
      font-weight: 500;
    }
    .script-preview .preview-item .preview-expiry-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .script-preview .preview-item .preview-expiry-tag {
      font-size: 10px;
      background: var(--blue-light);
      padding: 2px 10px;
      border-radius: 40px;
      border: 1px solid #bfdbfe;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .script-preview .preview-item .preview-expiry-tag .remove-expiry-preview {
      font-size: 13px;
      color: var(--red);
      cursor: pointer;
      font-weight: 700;
      line-height: 1;
    }
    .script-preview .preview-item .preview-expiry-tag .remove-expiry-preview:hover { color: #b91c1c; }
    .script-preview .preview-item .preview-expiry-tag.on-expiry-tag {
      background: #fef3c7;
      border-color: #fcd34d;
    }
    .script-preview .preview-item .preview-strike-input {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .script-preview .preview-item .preview-strike-input input[type="number"] {
      width: 56px;
      padding: 3px 8px;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      font-size: 12px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
    }
    .script-preview .preview-item .preview-strike-input input[type="number"]:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .preview-expiry-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 20px;
      background: var(--white);
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--grey-200);
    }
    .preview-expiry-row .expiry-group {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      flex: 1 1 0;
      min-width: 200px;
    }
    .preview-expiry-row .expiry-group .expiry-label {
      font-size: 10px;
      font-weight: 600;
      color: var(--grey-600);
      min-width: 60px;
    }
    .preview-expiry-row .expiry-group .expiry-control {
      display: flex;
      align-items: center;
      gap: 4px;
      flex-wrap: wrap;
    }
    .preview-expiry-row .expiry-group .expiry-control input[type="number"] {
      width: 48px;
      padding: 2px 4px;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
    }
    .preview-expiry-row .expiry-group .expiry-control input[type="number"]:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .preview-expiry-row .expiry-group .expiry-control .apply-expiry-btn {
      padding: 2px 12px;
      border: 1px solid var(--blue);
      border-radius: 40px;
      background: var(--blue);
      color: white;
      font-size: 10px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      line-height: 1.8;
    }
    .preview-expiry-row .expiry-group .expiry-control .apply-expiry-btn:hover { background: #1d4ed8; }
    .preview-expiry-row .expiry-group .expiry-tags {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .script-preview .empty-preview {
      grid-column: 1 / -1;
      text-align: center;
      padding: 24px 0;
      color: var(--grey-400);
      font-size: 13px;
    }

    /* Remove cross button in preview */
    .preview-item .delete-script-btn {
      display: none !important;
    }

    @media (min-width: 769px) {
      .preview-expiry-row {
        flex-wrap: nowrap;
      }
      .preview-expiry-row .expiry-group {
        flex: 1 1 0;
        min-width: 0;
      }
    }

    .page-scripts { display: none; }
    .page-scripts.active { display: block; }

    .page-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      flex-wrap: wrap;
      gap: 16px;
    }
    .page-header .page-title {
      font-size: 20px;
      font-weight: 600;
      color: var(--dark);
      flex: 1;
    }
    .page-header .page-title span { color: var(--grey-400); font-weight: 400; }
    .page-header .close-page-btn {
      font-size: 26px;
      cursor: pointer;
      color: var(--grey-400);
      line-height: 1;
      padding: 0 4px;
      background: none;
      border: none;
      font-family: 'Inter', sans-serif;
      flex-shrink: 0;
    }
    .page-header .close-page-btn:hover { color: var(--dark); }

    .page-search-bar {
      display: flex;
      gap: 14px;
      margin-bottom: 18px;
      flex-wrap: wrap;
      align-items: stretch;
    }
    .page-search-bar input {
      flex: 1;
      min-width: 220px;
      padding: 8px 16px;
      border: 1px solid var(--grey-200);
      border-radius: 40px;
      font-size: 14px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
      height: 42px;
    }
    .page-search-bar input:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .page-search-bar input::placeholder { color: var(--grey-400); font-size: 12px; }
    .page-search-bar .select-all-btn {
      padding: 0 24px;
      border: 1px solid var(--blue);
      border-radius: 40px;
      background: var(--blue);
      color: white;
      font-size: 13px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
      height: 42px;
      display: flex;
      align-items: center;
      justify-content: center;
      line-height: 1;
    }
    .page-search-bar .select-all-btn:hover { background: #1d4ed8; }
    .page-search-bar .select-all-btn.deselect {
      background: var(--grey-200);
      border-color: var(--grey-200);
      color: var(--dark);
    }
    .page-search-bar .select-all-btn.deselect:hover { background: var(--grey-100); }

    .page-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 4px;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      padding: 10px 16px;
      background: var(--white);
      max-height: 520px;
      overflow-y: auto;
    }
    .page-grid .page-script-item {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      border-bottom: 1px solid var(--grey-100);
      font-size: 13px;
      cursor: pointer;
    }
    .page-grid .page-script-item:last-child { border-bottom: none; }
    .page-grid .page-script-item:hover { background: var(--grey-50); }
    .page-grid .page-script-item .script-info {
      display: flex;
      align-items: center;
      gap: 12px;
      cursor: pointer;
      width: 100%;
    }
    .page-grid .page-script-item .script-info input[type="checkbox"] {
      width: 16px;
      height: 16px;
      accent-color: var(--blue);
      cursor: pointer;
      pointer-events: none;
    }
    .page-grid .page-script-item .script-info .s-name { font-weight: 500; cursor: pointer; user-select: none; }
    .page-grid .page-script-item .script-info .s-symbol { font-size: 11px; color: var(--grey-400); cursor: pointer; user-select: none; }
    
    /* Remove cross button from page grid */
    .page-grid .page-script-item .remove-page-script {
      display: none !important;
    }
    
    .page-grid .empty-page {
      grid-column: 1 / -1;
      text-align: center;
      padding: 32px 0;
      color: var(--grey-400);
      font-size: 14px;
    }

    .page-footer {
      display: flex;
      justify-content: flex-end;
      gap: 14px;
      padding-top: 24px;
      border-top: 1px solid var(--grey-100);
      margin-top: 24px;
      flex-wrap: wrap;
    }
    .page-footer button {
      padding: 10px 32px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      border-radius: 40px;
      cursor: pointer;
      border: 1px solid var(--grey-200);
      background: var(--white);
      color: var(--dark);
    }
    .page-footer button:hover { background: var(--grey-50); }
    .page-footer .btn-add { background: var(--blue); border-color: var(--blue); color: white; }
    .page-footer .btn-add:hover { background: #1d4ed8; }

    .form-actions {
      display: flex;
      gap: 14px;
      justify-content: flex-end;
      padding-top: 24px;
      border-top: 1px solid var(--grey-100);
      margin-top: 24px;
      flex-wrap: wrap;
      align-items: center;
    }
    .form-actions .left-group { display: flex; gap: 14px; margin-right: auto; }
    .form-actions .right-group { display: flex; gap: 14px; }
    .form-actions button {
      padding: 10px 32px;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Inter', sans-serif;
      border-radius: 40px;
      cursor: pointer;
      border: 1px solid var(--grey-200);
      background: var(--white);
      color: var(--dark);
    }
    .form-actions button:hover { background: var(--grey-50); }
    .form-actions .btn-primary { background: var(--dark); border-color: var(--dark); color: white; }
    .form-actions .btn-primary:hover { background: #2a2a2a; }
    .form-actions .btn-secondary { background: transparent; border-color: var(--grey-200); color: var(--dark); }
    @media (max-width: 768px) { .form-actions .left-group .btn-secondary { display: none; } }

    .toast {
      position: fixed;
      bottom: 28px;
      right: 28px;
      background: var(--dark);
      color: white;
      padding: 14px 28px;
      font-size: 14px;
      font-weight: 500;
      border-radius: var(--radius-sm);
      box-shadow: 0 8px 28px rgba(0,0,0,0.06);
      z-index: 2000;
      opacity: 0;
      transform: translateY(16px);
      transition: all 0.3s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: translateY(0); }

    .footer-note {
      margin-top: 24px;
      text-align: right;
      font-size: 13px;
      color: var(--grey-600);
      border-top: 1px solid var(--grey-100);
      padding-top: 16px;
    }

    .user-selection {
      margin-bottom: 20px;
      padding: 16px 20px;
      background: var(--grey-50);
      border-radius: var(--radius-sm);
      border: 1px solid var(--grey-200);
    }
    .user-selection .user-select-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      margin-bottom: 10px;
    }
    .user-selection .user-select-header .user-label { font-size: 13px; font-weight: 600; color: var(--dark); }
    .user-selection .user-search {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      flex: 1;
      min-width: 240px;
    }
    .user-selection .user-search .user-dropdown {
      position: relative;
      flex: 1;
      min-width: 200px;
    }
    .user-selection .user-search .user-dropdown input {
      width: 100%;
      padding: 8px 16px;
      border: 1px solid var(--grey-200);
      border-radius: 40px;
      font-size: 13px;
      font-family: 'Inter', sans-serif;
      background: var(--white);
      color: var(--dark);
    }
    .user-selection .user-search .user-dropdown input:focus {
      outline: none;
      border-color: var(--dark);
      box-shadow: 0 0 0 3px rgba(0,0,0,0.04);
    }
    .user-selection .user-search .user-dropdown .dropdown-list {
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      right: 0;
      background: white;
      border: 1px solid var(--grey-200);
      border-radius: var(--radius-sm);
      max-height: 200px;
      overflow-y: auto;
      z-index: 100;
      display: none;
      box-shadow: var(--shadow-hover);
      min-width: 220px;
    }
    .user-selection .user-search .user-dropdown .dropdown-list.show { display: block; }
    .user-selection .user-search .user-dropdown .dropdown-list .dropdown-item {
      padding: 8px 16px;
      font-size: 13px;
      cursor: pointer;
      border-bottom: 1px solid var(--grey-100);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .user-selection .user-search .user-dropdown .dropdown-list .dropdown-item:hover { background: var(--grey-50); }
    .user-selection .user-search .user-dropdown .dropdown-list .dropdown-item .user-role { font-size: 10px; color: var(--grey-400); }
    .user-selection .user-search .user-dropdown .dropdown-list .empty-msg {
      padding: 10px 14px;
      color: var(--grey-400);
      font-size: 12px;
      text-align: center;
    }

    .user-selection .quick-apply {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed var(--grey-200);
    }
    .user-selection .quick-apply .quick-label { font-size: 12px; font-weight: 500; color: var(--grey-600); }
    .user-selection .quick-apply .quick-btn {
      padding: 4px 16px;
      border: 1px solid var(--grey-200);
      border-radius: 40px;
      background: var(--white);
      font-size: 12px;
      font-weight: 500;
      font-family: 'Inter', sans-serif;
      color: var(--dark);
      cursor: pointer;
      transition: all 0.15s;
    }
    .user-selection .quick-apply .quick-btn:hover { background: var(--grey-100); }
    .user-selection .quick-apply .quick-btn.primary-btn { border-color: var(--blue); color: var(--blue); }
    .user-selection .quick-apply .quick-btn.primary-btn:hover { background: var(--blue-light); }
    .user-selection .quick-apply .quick-btn.demo-btn { border-color: var(--green); color: var(--green); }
    .user-selection .quick-apply .quick-btn.demo-btn:hover { background: #dcfce7; }
    .user-selection .quick-apply .quick-btn .badge-count {
      font-size: 9px;
      background: var(--grey-200);
      padding: 0 6px;
      border-radius: 40px;
      margin-left: 4px;
    }

    .user-selection .selected-users {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 10px;
      min-height: 32px;
    }
    .user-selection .selected-users .user-tag {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px 4px 14px;
      background: var(--blue-light);
      border: 1px solid #bfdbfe;
      border-radius: 40px;
      font-size: 12px;
      font-weight: 500;
      color: var(--dark);
    }
    .user-selection .selected-users .user-tag .remove-user {
      font-size: 15px;
      color: var(--red);
      cursor: pointer;
      line-height: 1;
      padding: 0 2px;
      font-weight: 700;
    }
    .user-selection .selected-users .user-tag .remove-user:hover { color: #b91c1c; }
    .user-selection .selected-users .empty-users { font-size: 13px; color: var(--grey-400); padding: 4px 0; }

    /* phone view adjustments – keep as is */
    @media (max-width: 768px) {
      .header h1 { font-size: 22px; }
      .super-admin-icon { padding: 5px 12px 5px 10px; }
      .super-admin-icon .icon-wrapper { width: 28px; height: 28px; }
      .super-admin-icon .icon-wrapper svg { width: 16px; height: 16px; }
      .super-admin-icon .label-text { font-size: 11px; }
      .super-admin-icon .label-text .role-sub { font-size: 8px; }
      .panel { padding: 12px 12px; }
      .panel-header h2 { font-size: 14px; }
      .scripts-grid { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); }
      .user-selection .user-select-header { flex-direction: column; align-items: stretch; }
      .user-selection .user-search { flex-direction: column; align-items: stretch; }
      .user-selection .user-search .user-dropdown { min-width: unset; width: 100%; }
      .user-selection .user-search .user-dropdown input { width: 100%; }
      .user-selection .quick-apply { flex-wrap: wrap; }
      .copy-section { flex-direction: column; align-items: stretch; }
      .copy-section .copy-search-wrap { min-width: unset; }
      .expiry-block .block-header { flex-direction: column; align-items: stretch; }
      .expiry-block .block-controls { flex-direction: column; align-items: stretch; }
      .expiry-blocks { flex-direction: column; }
      .script-preview .preview-grid { grid-template-columns: 1fr; }
      .script-preview .preview-item .preview-row { flex-wrap: wrap; }
      .segment-nav .seg-item { padding: 3px 8px 3px 10px; }
      .segment-nav .seg-item .seg-tab { font-size: 11px; }
      .segment-nav .all-scripts-btn { font-size: 11px; padding: 6px 14px; }
      .segment-nav .remove-mode-toggle { font-size: 11px; padding: 6px 14px; }
      .page-header .page-title { font-size: 16px; }
      .page-search-bar { flex-wrap: wrap; }
      .page-search-bar .select-all-btn { padding: 0 14px; font-size: 11px; height: 36px; }
      .form-actions { flex-wrap: wrap; }
      .form-actions .left-group { margin-right: 0; flex-wrap: wrap; }
      .form-actions .right-group { flex-wrap: wrap; }
      .default-scripts-row { justify-content: center; }
      .default-scripts-row .set-default-btn { width: 100%; text-align: center; }
    }

    @media (max-width: 480px) {
      .header h1 { font-size: 20px; }
      .super-admin-icon { padding: 4px 10px 4px 8px; }
      .super-admin-icon .icon-wrapper { width: 22px; height: 22px; }
      .super-admin-icon .icon-wrapper svg { width: 13px; height: 13px; }
      .super-admin-icon .label-text { font-size: 9px; }
      .super-admin-icon .label-text .role-sub { font-size: 7px; }
      .panel { padding: 10px 8px; }
      .panel-header h2 { font-size: 12px; }
      .scripts-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
      .scripts-grid .script-item { font-size: 11px; }
      .segment-nav .seg-item { padding: 2px 6px 2px 8px; }
      .segment-nav .seg-item .seg-tab { font-size: 10px; }
      .segment-nav .seg-item .seg-toggle { width: 28px; height: 16px; }
      .segment-nav .seg-item .seg-toggle::after { width: 12px; height: 12px; }
      .segment-nav .seg-item .seg-toggle.active::after { transform: translateX(12px); }
      .segment-nav .all-scripts-btn { font-size: 10px; padding: 4px 10px; }
      .segment-nav .remove-mode-toggle { font-size: 10px; padding: 4px 10px; }
      .user-selection .user-select-header { flex-direction: column; align-items: stretch; }
      .user-selection .user-search { flex-direction: column; align-items: stretch; }
      .user-selection .user-search .user-dropdown { min-width: unset; width: 100%; }
      .user-selection .user-search .user-dropdown input { width: 100%; }
      .user-selection .quick-apply { flex-wrap: wrap; }
      .copy-section { flex-direction: column; align-items: stretch; }
      .copy-section .copy-search-wrap { min-width: unset; }
      .expiry-block .block-header { flex-direction: column; align-items: stretch; }
      .expiry-block .block-controls { flex-direction: column; align-items: stretch; }
      .expiry-blocks { flex-direction: column; }
      .script-preview .preview-grid { grid-template-columns: 1fr; }
      .script-preview .preview-item .preview-row { flex-wrap: wrap; }
      .page-header .page-title { font-size: 14px; }
      .page-header .close-page-btn { font-size: 20px; }
      .page-search-bar { flex-direction: column; align-items: stretch; }
      .page-search-bar input { min-width: unset; height: 36px; }
      .page-search-bar .select-all-btn { width: 100%; text-align: center; height: 36px; padding: 0 14px; font-size: 11px; }
      .page-grid .page-script-item { flex-wrap: wrap; gap: 4px; }
      .page-footer button { padding: 6px 16px; font-size: 11px; }
      .form-actions { flex-direction: column; align-items: stretch; }
      .form-actions .left-group { flex-direction: column; align-items: stretch; }
      .form-actions .right-group { flex-direction: column; align-items: stretch; }
      .form-actions button { width: 100%; text-align: center; }
      .default-scripts-row .set-default-btn { width: 100%; text-align: center; }
    }
  ` }} />

      <div className="page active" id="pageMain">
        <div className="header">
          <h1>Scripts Management <span>(Templates)</span></h1>
          <div className="super-admin-icon">
            <div className="icon-wrapper">
              <svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5zm0 14.5l-10-5v5l10 5 10-5v-5l-10 5z"/></svg>
            </div>
            <div className="label-text">
              Templates
              <span className="role-sub">Script Permissions</span>
            </div>
          </div>
        </div>

        <div className="panel">
          <div className="panel-header">
            <h2>Configure Allowed Scripts</h2>
            <span className="badge-role">per template</span>
          </div>

          
          <div className="template-selector" style={{ marginBottom: 24, display: 'flex', gap: '20px', alignItems: 'center', flexWrap: 'wrap' }}>
            <div>
              <label style={{display: 'block', fontSize: '12px', fontWeight: 600, color: 'var(--grey-600)', marginBottom: '6px'}}>Select Template</label>
              <select
                style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--grey-200)', background: 'var(--white)', fontSize: 14, width: '300px', fontFamily: 'inherit' }}
                value={selectedTemplate?.id || ''}
                onChange={e => {
                  const tmpl = templates.find(t => t.id === e.target.value);
                  if (tmpl) { setSelectedTemplate(tmpl); setRemoveMode(false); }
                }}
              >
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name} {t.is_default ? '(Default)' : ''}</option>
                ))}
              </select>
            </div>
            {selectedTemplate && !selectedTemplate.is_default && (
              <div style={{ marginTop: '20px' }}>
                <button 
                  style={{ padding: '10px 24px', background: 'var(--blue)', color: 'white', border: 'none', borderRadius: '40px', fontWeight: 600, cursor: 'pointer' }}
                  onClick={handleSetDefault}
                  disabled={settingDefault}
                >
                  {settingDefault ? 'Setting...' : 'Set as Default Template'}
                </button>
              </div>
            )}
          </div>

          <div className="user-selection" style={{ padding: '16px', background: 'var(--grey-50)', borderRadius: '8px', border: '1px solid var(--grey-200)', marginBottom: '16px' }}>
            <div className="user-select-header" style={{ display: 'flex', gap: '16px', alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <span className="user-label" style={{ fontWeight: 600, color: 'var(--dark)', marginTop: '8px', minWidth: '120px' }}>Apply to Users</span>
              <div className="user-search" style={{ position: 'relative', flexGrow: 1, maxWidth: '400px' }}>
                <input 
                  type="text" 
                  placeholder="Search users..." 
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--grey-200)' }}
                  value={userSearchQuery}
                  onChange={e => { setUserSearchQuery(e.target.value); setUserDropdownOpen(true); }}
                  onFocus={() => setUserDropdownOpen(true)}
                  onBlur={() => setTimeout(() => setUserDropdownOpen(false), 200)}
                />
                {userDropdownOpen && (
                  <div className="dropdown-list" style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', border: '1px solid var(--grey-200)', borderRadius: '6px', marginTop: '4px', maxHeight: '200px', overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                    {allUsers.filter(u => !selectedUsers.find(su => su.id === u.id) && (u.first_name.toLowerCase().includes(userSearchQuery.toLowerCase()) || (u.last_name || '').toLowerCase().includes(userSearchQuery.toLowerCase()) || u.user_id.toLowerCase().includes(userSearchQuery.toLowerCase()))).slice(0, 20).map(u => (
                      <div key={u.id} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--grey-100)' }} onMouseDown={() => setSelectedUsers([...selectedUsers, u])}>
                        <div style={{ fontWeight: 600, fontSize: '13px' }}>{u.first_name} {u.last_name}</div>
                        <div style={{ fontSize: '11px', color: 'var(--grey-400)' }}>{u.user_id}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="quick-apply" style={{ display: 'flex', gap: '12px', marginTop: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="quick-label" style={{ fontSize: '13px', color: 'var(--grey-600)' }}>Quick Apply:</span>
              <button style={{ padding: '6px 12px', borderRadius: '40px', background: 'var(--blue)', color: 'white', border: 'none', fontSize: '12px', cursor: 'pointer' }} onClick={() => setSelectedUsers(allUsers)}>Apply to All</button>
              <button style={{ padding: '6px 12px', borderRadius: '40px', background: '#ec4899', color: 'white', border: 'none', fontSize: '12px', cursor: 'pointer' }} onClick={() => setSelectedUsers(allUsers.filter(u => u.is_demo))}>Demo Accounts</button>
              <button style={{ padding: '6px 12px', borderRadius: '40px', background: 'transparent', color: 'var(--grey-600)', border: '1px solid var(--grey-200)', fontSize: '12px', cursor: 'pointer' }} onClick={() => setSelectedUsers([])}>Clear All</button>
              
              {selectedUsers.length > 0 && (
                <button 
                   style={{ padding: '6px 16px', borderRadius: '40px', background: 'var(--green)', color: 'white', border: 'none', fontSize: '12px', cursor: 'pointer', marginLeft: 'auto', fontWeight: 'bold' }} 
                   onClick={handleApplyToUsers}
                   disabled={applyingUsers}
                >
                   {applyingUsers ? 'Saving...' : `Save (${selectedUsers.length})`}
                </button>
              )}
            </div>

            <div className="selected-users" style={{ marginTop: '16px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              {selectedUsers.length === 0 ? <span style={{ fontSize: '13px', color: 'var(--grey-400)' }}>No users selected</span> : (
                selectedUsers.map(u => (
                  <span key={u.id} style={{ padding: '4px 8px', background: 'var(--white)', border: '1px solid var(--grey-200)', borderRadius: '4px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {u.first_name}
                    <button style={{ background: 'none', border: 'none', color: 'var(--grey-400)', cursor: 'pointer', padding: 0 }} onClick={() => setSelectedUsers(selectedUsers.filter(su => su.id !== u.id))}>✕</button>
                  </span>
                ))
              )}
            </div>
          </div>

          <div className="copy-section" style={{ padding: '16px', background: 'var(--white)', borderRadius: '8px', border: '1px solid var(--grey-200)', marginBottom: '24px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="copy-label" style={{ fontWeight: 600, color: 'var(--dark)' }}>Copy Scripts From:</span>
            <div className="copy-search-wrap" style={{ position: 'relative', flexGrow: 1, maxWidth: '300px' }}>
              <input 
                type="text" 
                placeholder="Search user..." 
                style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid var(--grey-200)' }}
                value={copySearchQuery}
                onChange={e => { setCopySearchQuery(e.target.value); setCopyDropdownOpen(true); }}
                onFocus={() => setCopyDropdownOpen(true)}
                onBlur={() => setTimeout(() => setCopyDropdownOpen(false), 200)}
              />
              {copyDropdownOpen && (
                <div className="copy-dropdown" style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'white', border: '1px solid var(--grey-200)', borderRadius: '6px', marginTop: '4px', maxHeight: '200px', overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}>
                  {allUsers.filter(u => u.first_name.toLowerCase().includes(copySearchQuery.toLowerCase()) || (u.last_name || '').toLowerCase().includes(copySearchQuery.toLowerCase()) || u.user_id.toLowerCase().includes(copySearchQuery.toLowerCase())).slice(0, 20).map(u => (
                    <div key={u.id} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--grey-100)' }} onMouseDown={() => { setSelectedCopyUser(u); setCopySearchQuery(''); }}>
                      <div style={{ fontWeight: 600, fontSize: '13px' }}>{u.first_name} {u.last_name}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            {selectedCopyUser && (
              <span style={{ padding: '6px 12px', background: 'var(--grey-50)', border: '1px solid var(--grey-200)', borderRadius: '4px', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                {selectedCopyUser.first_name} {selectedCopyUser.last_name}
                <button style={{ background: 'none', border: 'none', color: 'var(--grey-400)', cursor: 'pointer', padding: 0 }} onClick={() => setSelectedCopyUser(null)}>✕</button>
              </span>
            )}
            
            <button 
               style={{ padding: '8px 16px', borderRadius: '6px', background: selectedCopyUser ? 'var(--dark)' : 'var(--grey-200)', color: selectedCopyUser ? 'white' : 'var(--grey-400)', border: 'none', fontWeight: 600, cursor: selectedCopyUser ? 'pointer' : 'not-allowed' }}
               disabled={!selectedCopyUser || copyingScripts}
               onClick={handleCopyScripts}
            >
               {copyingScripts ? 'Copying...' : 'Copy Scripts'}
            </button>
          </div>


          <div className="segment-nav">
            {SEGMENTS.map(seg => (
              <div key={seg} className={`seg-item ${activeSegment === seg ? 'active' : ''}`}>
                <button 
                  className={`seg-tab ${activeSegment === seg ? 'active' : ''}`}
                  onClick={() => {
                    setActiveSegment(seg);
                    setInstrSearch(''); // clear search on segment change
                  }}
                >
                  {seg}
                </button>
              </div>
            ))}
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
            <div className="page-search" style={{ flexGrow: 1, position: 'relative' }}>
              <input 
                type="text" 
                style={{ width: '100%', padding: '10px 16px', borderRadius: '40px', border: '1px solid var(--grey-200)' }}
                placeholder={`Search ${activeSegment} (e.g. ${SEGMENT_DEFAULTS[activeSegment] || 'NIFTY'})...`}
                value={instrSearch}
                onChange={e => handleSearchChange(e.target.value)}
              />
            </div>
            
            <button 
              className={`remove-mode-toggle ${removeMode ? 'active' : ''}`}
              style={{ padding: '10px 22px', borderRadius: '40px', border: '1px solid var(--red)', background: removeMode ? 'var(--red)' : 'transparent', color: removeMode ? 'white' : 'var(--red)', fontWeight: 600, cursor: 'pointer' }}
              onClick={() => setRemoveMode(!removeMode)}
            >
              {removeMode ? '✕ Cancel Remove' : 'Remove Mode'}
            </button>
          </div>

          <div id="scriptsContainer">
            <div className="scripts-grid" style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: '12px'
            }}>
              {templateScriptsLoading || instrLoading ? (
                <div className="empty-scripts">Loading scripts...</div>
              ) : scriptsToShow.length === 0 ? (
                <div className="empty-scripts">No scripts allowed or matching search.</div>
              ) : (
                scriptsToShow.map(script => (
                  <div 
                    key={script.symbol} 
                    className={`script-item ${removeMode && script.allowed ? 'remove-mode' : ''}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '10px 14px',
                      borderRadius: '8px',
                      border: '1px solid var(--grey-200)',
                      background: 'var(--white)',
                      gap: '8px',
                      cursor: removeMode ? 'default' : 'pointer'
                    }}
                    onClick={(e) => {
                      if (removeMode || addingSymbols.has(script.symbol)) return;
                      // Don't toggle if clicking a button inside
                      if ((e.target as HTMLElement).closest('button')) return;
                      handleToggleScript(script.symbol, !script.allowed);
                    }}
                  >
                    <input 
                      type="checkbox" 
                      className={`script-checkbox ${removeMode && script.allowed ? 'hidden' : ''}`}
                      checked={script.allowed}
                      readOnly
                      style={{ 
                        display: (removeMode && script.allowed) ? 'none' : 'inline-block'
                      }}
                    />
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span className="script-name" style={{ fontSize: '12px', fontWeight: 600, color: 'var(--dark)' }}>
                        {script.name || script.symbol}
                      </span>
                      {script.name && script.name !== script.symbol && (
                        <span style={{ fontSize: '10px', color: 'var(--grey-400)' }}>{script.symbol}</span>
                      )}
                    </div>
                    {addingSymbols.has(script.symbol) && <span style={{marginLeft: 'auto', fontSize: 10, color: '#888'}}>...</span>}
                    
                    {removeMode && script.allowed && (
                      <button 
                        style={{ marginLeft: 'auto', background: 'var(--red)', color: 'white', border: 'none', borderRadius: '50%', width: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: '12px' }}
                        onClick={(e) => handleRemoveSingle(script.symbol, e)}
                        title="Remove this script"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          <div style={{ marginTop: '24px', display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'center', borderTop: '1px solid var(--grey-200)', paddingTop: '20px' }}>
            <button 
              style={{ width: '100%', padding: '12px 24px', background: '#000000', color: '#ffffff', border: 'none', borderRadius: '40px', fontWeight: 600, cursor: (selectedTemplate?.is_default || settingDefault) ? 'not-allowed' : 'pointer' }}
              onClick={handleSetDefault}
              disabled={selectedTemplate?.is_default || settingDefault}
            >
              {settingDefault ? 'Setting...' : 'Set as Default'}
            </button>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
              <div style={{ width: '100%', height: '1px', background: 'var(--grey-200)' }} />
              <div style={{ width: '100%', height: '1px', background: 'var(--grey-200)' }} />
            </div>
            
            <button 
              style={{ width: '100%', padding: '12px 24px', background: '#000000', color: '#ffffff', border: 'none', borderRadius: '40px', fontWeight: 600, cursor: 'pointer' }}
              onClick={() => setToast({ message: 'Changes saved successfully', type: 'success' })}
            >
              Save Changes
            </button>
          </div>
          
        </div>
      </div>
      
      {toast && <Toast toast={toast} onDismiss={() => setToast(null)} />}
    </div>
  );
}
