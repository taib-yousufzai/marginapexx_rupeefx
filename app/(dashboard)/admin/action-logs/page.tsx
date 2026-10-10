'use client';

import { useState, useEffect, useCallback } from 'react';
import { apiCall } from '@/components/admin/AdminUtils';

interface ActionLog {
  id: string;
  created_at: string;
  username: string;
  role: string;
  action_type: string;
  module: string;
  ip_address: string;
  is_success: boolean;
  error_message: string | null;
  wallet_before: number | null;
  wallet_after: number | null;
}

export default function ActionLogsPage() {
  const [logs, setLogs] = useState<ActionLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterModule, setFilterModule] = useState('ALL');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [dbSource, setDbSource] = useState<string>('');

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterModule !== 'ALL') params.set('module', filterModule);
    if (search) params.set('search', search);

    try {
      const { ok, data } = await apiCall(`/api/admin/action-logs?${params.toString()}`, { method: 'GET' });
      if (!ok) {
        setErrorMsg((data as any)?.error || 'Access Denied. You do not have permission to view Action Logs.');
      } else if ((data as any)?.logs) {
        setLogs((data as any).logs);
        setDbSource((data as any).source || '');
        setErrorMsg(null);
      }
    } catch (err: any) {
      console.error(err);
      setErrorMsg('Failed to load Action Logs.');
    } finally {
      setLoading(false);
    }
  }, [search, filterModule]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const isRailway = dbSource === 'railway_postgres';

  return (
    <div style={{
      minHeight: '100vh',
      backgroundColor: '#070a12',
      color: '#e2e8f0',
      padding: '28px 32px',
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif"
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '24px',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <h1 style={{
            fontSize: '22px',
            fontWeight: '700',
            letterSpacing: '-0.02em',
            color: '#f8fafc',
            margin: 0
          }}>
            Audit Trail (Action Logs)
          </h1>
          {dbSource && (
            <span style={{
              fontSize: '12px',
              fontWeight: '600',
              padding: '4px 12px',
              borderRadius: '20px',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              background: isRailway ? 'rgba(147, 51, 234, 0.15)' : 'rgba(16, 185, 129, 0.15)',
              color: isRailway ? '#c084fc' : '#34d399',
              border: isRailway ? '1px solid rgba(168, 85, 247, 0.4)' : '1px solid rgba(16, 185, 129, 0.4)'
            }}>
              <span style={{
                width: '6px',
                height: '6px',
                borderRadius: '50%',
                background: isRailway ? '#a855f7' : '#10b981',
                boxShadow: isRailway ? '0 0 8px #a855f7' : '0 0 8px #10b981'
              }} />
              Storage: {isRailway ? 'Railway Postgres' : 'Supabase'}
            </span>
          )}
        </div>

        <button
          onClick={fetchLogs}
          disabled={loading}
          style={{
            background: 'linear-gradient(135deg, #2563eb, #1d4ed8)',
            color: '#ffffff',
            border: 'none',
            padding: '8px 18px',
            borderRadius: '8px',
            fontSize: '13px',
            fontWeight: '600',
            cursor: loading ? 'not-allowed' : 'pointer',
            boxShadow: '0 2px 8px rgba(37, 99, 235, 0.3)',
            transition: 'all 0.2s ease',
            opacity: loading ? 0.7 : 1
          }}
        >
          {loading ? 'Refreshing...' : '↻ Refresh'}
        </button>
      </div>

      {/* Filter Toolbar */}
      <div style={{
        display: 'flex',
        gap: '12px',
        marginBottom: '20px',
        flexWrap: 'wrap'
      }}>
        <input
          type="text"
          placeholder="Search username, action, or IP address..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            flex: 1,
            minWidth: '240px',
            backgroundColor: '#0f172a',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
            padding: '10px 14px',
            fontSize: '13.5px',
            color: '#f8fafc',
            outline: 'none'
          }}
        />

        <select
          value={filterModule}
          onChange={(e) => setFilterModule(e.target.value)}
          style={{
            backgroundColor: '#0f172a',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            borderRadius: '8px',
            padding: '10px 16px',
            fontSize: '13.5px',
            color: '#f8fafc',
            outline: 'none',
            cursor: 'pointer'
          }}
        >
          <option value="ALL">All Modules</option>
          <option value="TRADING">Trading</option>
          <option value="AUTH">Authentication</option>
          <option value="WALLET">Wallet</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>

      {/* Logs Table Card */}
      <div style={{
        backgroundColor: '#0b1120',
        borderRadius: '12px',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        overflow: 'hidden',
        boxShadow: '0 8px 30px rgba(0, 0, 0, 0.4)'
      }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '13px',
            textAlign: 'left'
          }}>
            <thead>
              <tr style={{
                backgroundColor: 'rgba(15, 23, 42, 0.9)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                color: '#94a3b8',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontSize: '11px',
                fontWeight: '600'
              }}>
                <th style={{ padding: '14px 18px' }}>Timestamp</th>
                <th style={{ padding: '14px 18px' }}>User</th>
                <th style={{ padding: '14px 18px' }}>Module</th>
                <th style={{ padding: '14px 18px' }}>Action</th>
                <th style={{ padding: '14px 18px' }}>Status</th>
                <th style={{ padding: '14px 18px' }}>IP Address</th>
                <th style={{ padding: '14px 18px', textAlign: 'right' }}>Wallet Change</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
                    Loading action logs...
                  </td>
                </tr>
              ) : errorMsg ? (
                <tr>
                  <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: '#f43f5e', fontWeight: '500' }}>
                    {errorMsg}
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '40px', textAlign: 'center', color: '#64748b' }}>
                    No action logs found.
                  </td>
                </tr>
              ) : (
                logs.map((log, idx) => (
                  <tr
                    key={log.id}
                    style={{
                      borderBottom: '1px solid rgba(255, 255, 255, 0.04)',
                      backgroundColor: idx % 2 === 0 ? 'transparent' : 'rgba(255, 255, 255, 0.015)',
                      transition: 'background-color 0.15s ease'
                    }}
                  >
                    <td style={{ padding: '13px 18px', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                      {new Date(log.created_at).toLocaleString()}
                    </td>
                    <td style={{ padding: '13px 18px' }}>
                      <div style={{ fontWeight: '600', color: '#f1f5f9' }}>{log.username || 'System'}</div>
                      <div style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {log.role || 'GUEST'}
                      </div>
                    </td>
                    <td style={{ padding: '13px 18px' }}>
                      <span style={{
                        padding: '3px 8px',
                        backgroundColor: 'rgba(255, 255, 255, 0.05)',
                        border: '1px solid rgba(255, 255, 255, 0.08)',
                        borderRadius: '4px',
                        fontSize: '11.5px',
                        fontWeight: '500',
                        color: '#cbd5e1'
                      }}>
                        {log.module}
                      </span>
                    </td>
                    <td style={{ padding: '13px 18px', fontWeight: '600', color: '#f8fafc' }}>
                      {log.action_type}
                    </td>
                    <td style={{ padding: '13px 18px' }}>
                      {log.is_success ? (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '11.5px',
                          fontWeight: '600',
                          backgroundColor: 'rgba(16, 185, 129, 0.1)',
                          color: '#34d399',
                          border: '1px solid rgba(16, 185, 129, 0.25)'
                        }}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: '#10b981' }} />
                          Success
                        </span>
                      ) : (
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          padding: '2px 8px',
                          borderRadius: '12px',
                          fontSize: '11.5px',
                          fontWeight: '600',
                          backgroundColor: 'rgba(244, 63, 94, 0.1)',
                          color: '#fb7185',
                          border: '1px solid rgba(244, 63, 94, 0.25)'
                        }} title={log.error_message || 'Failed'}>
                          <span style={{ width: '5px', height: '5px', borderRadius: '50%', backgroundColor: '#f43f5e' }} />
                          Failed
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '13px 18px', fontFamily: 'monospace', fontSize: '11.5px', color: '#64748b' }}>
                      {log.ip_address || '-'}
                    </td>
                    <td style={{ padding: '13px 18px', textAlign: 'right', fontWeight: '600' }}>
                      {log.wallet_before !== null && log.wallet_after !== null ? (
                        <span style={{
                          color: log.wallet_after > log.wallet_before ? '#34d399' : log.wallet_after < log.wallet_before ? '#fb7185' : '#64748b'
                        }}>
                          {log.wallet_after > log.wallet_before ? '+' : ''}
                          {(log.wallet_after - log.wallet_before).toFixed(2)}
                        </span>
                      ) : (
                        <span style={{ color: '#475569' }}>-</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
