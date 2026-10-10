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

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold text-gray-100">Audit Trail (Action Logs)</h1>
          {dbSource && (
            <span
              className={`text-xs px-2.5 py-1 rounded-full font-medium ${
                dbSource === 'railway_postgres'
                  ? 'bg-purple-900/40 text-purple-300 border border-purple-700/50'
                  : 'bg-emerald-900/40 text-emerald-300 border border-emerald-700/50'
              }`}
            >
              Storage: {dbSource === 'railway_postgres' ? 'Railway Postgres' : 'Supabase'}
            </span>
          )}
        </div>
        <button onClick={fetchLogs} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md">
          Refresh
        </button>
      </div>

      <div className="flex gap-4">
        <input 
          type="text" 
          placeholder="Search username, action, or IP..." 
          className="bg-gray-800 border border-gray-700 text-white px-4 py-2 rounded-md flex-1 focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select 
          className="bg-gray-800 border border-gray-700 text-white px-4 py-2 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          value={filterModule}
          onChange={(e) => setFilterModule(e.target.value)}
        >
          <option value="ALL">All Modules</option>
          <option value="TRADING">Trading</option>
          <option value="AUTH">Authentication</option>
          <option value="WALLET">Wallet</option>
          <option value="ADMIN">Admin</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-700">
        <table className="min-w-full divide-y divide-gray-700 text-sm text-left">
          <thead className="bg-gray-800 text-gray-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Timestamp</th>
              <th className="px-4 py-3 font-semibold">User</th>
              <th className="px-4 py-3 font-semibold">Module</th>
              <th className="px-4 py-3 font-semibold">Action</th>
              <th className="px-4 py-3 font-semibold">Status</th>
              <th className="px-4 py-3 font-semibold">IP Address</th>
              <th className="px-4 py-3 font-semibold">Wallet Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-800 bg-gray-900 text-gray-300">
            {loading ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">Loading logs...</td>
              </tr>
            ) : errorMsg ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-rose-500 font-medium">{errorMsg}</td>
              </tr>
            ) : logs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-gray-500">No action logs found.</td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-800/50 transition-colors">
                  <td className="px-4 py-3 whitespace-nowrap text-gray-400">{new Date(log.created_at).toLocaleString()}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-200">{log.username || 'System'}</div>
                    <div className="text-xs text-gray-500 uppercase tracking-wider">{log.role || 'GUEST'}</div>
                  </td>
                  <td className="px-4 py-3">
                    <span className="px-2 py-1 bg-gray-800 rounded-md text-xs border border-gray-700">{log.module}</span>
                  </td>
                  <td className="px-4 py-3 font-medium text-gray-200">{log.action_type}</td>
                  <td className="px-4 py-3">
                    {log.is_success ? (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                        Success
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/20" title={log.error_message || 'Failed'}>
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500"></span>
                        Failed
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{log.ip_address}</td>
                  <td className="px-4 py-3 text-right">
                    {log.wallet_before !== null && log.wallet_after !== null ? (
                      <span className={log.wallet_after > log.wallet_before ? 'text-emerald-400' : log.wallet_after < log.wallet_before ? 'text-rose-400' : 'text-gray-500'}>
                        {log.wallet_after > log.wallet_before ? '+' : ''}{(log.wallet_after - log.wallet_before).toFixed(2)}
                      </span>
                    ) : (
                      <span className="text-gray-600">-</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
