'use client';
import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { signOut } from '@/lib/auth';
import { RequirePermission } from './RequirePermission';
import { Permission } from '@/lib/permissions';
import { getSavedTheme, applyTheme, cycleTheme, Theme } from '@/lib/theme';
import './Sidebar.css';

const navItems: { key: string, label: string, icon: string, path: string, perm?: Permission }[] = [
  { key: 'home', label: 'Dashboard', icon: 'fas fa-th-large', path: '/' },
  { key: 'watchlist', label: 'Watchlist', icon: 'fas fa-list', path: '/watchlist' },
  { key: 'order', label: 'Orders', icon: 'fas fa-file-invoice-dollar', path: '/order', perm: 'VIEW_OWN_ORDERS' },
  { key: 'position', label: 'Positions', icon: 'fas fa-chart-line', path: '/position', perm: 'VIEW_OWN_POSITIONS' },
  { key: 'history', label: 'History', icon: 'fas fa-history', path: '/history', perm: 'VIEW_OWN_TRADES' },
  { key: 'funds', label: 'Funds', icon: 'fas fa-wallet', path: '/funds', perm: 'VIEW_OWN_WALLET' },
  { key: 'rules', label: 'Rules', icon: 'fas fa-file-contract', path: '/rules' },
  { key: 'profile', label: 'Profile', icon: 'fas fa-user-circle', path: '/profile', perm: 'VIEW_OWN_PROFILE' },
  { key: 'users', label: 'Users', icon: 'fas fa-users', path: '/admin#users', perm: 'VIEW_USERS' },
  { key: 'admin', label: 'Admin', icon: 'fas fa-cogs', path: '/admin#settings', perm: 'MANAGE_GLOBAL_SETTINGS' },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [currentTheme, setCurrentTheme] = useState<Theme>('light');

  useEffect(() => {
    const updateThemeState = () => {
      setCurrentTheme(getSavedTheme());
    };
    updateThemeState();
    window.addEventListener('themeChanged', updateThemeState);
    return () => window.removeEventListener('themeChanged', updateThemeState);
  }, []);

  const handleToggleTheme = () => {
    const next = cycleTheme(currentTheme);
    applyTheme(next);
  };

  return (
    <aside className={`desktop-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img src="/icon-512x512.png" alt="Logo" className="logo-icon-img" />
          {!isCollapsed && <span className="logo-text">MARGIN<span>APEX</span></span>}
        </div>
        <button className="collapse-btn" onClick={() => setIsCollapsed(!isCollapsed)}>
          <i className={`fas fa-chevron-${isCollapsed ? 'right' : 'left'}`}></i>
        </button>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive = pathname === item.path || (item.path !== '/' && pathname.startsWith(item.path));
          const linkNode = (
            <Link key={item.key} href={item.path} className={`sidebar-item ${isActive ? 'active' : ''}`}>
              <div className="sidebar-icon">
                <i className={item.icon}></i>
              </div>
              {!isCollapsed && <span className="sidebar-label">{item.label}</span>}
              {isActive && <div className="active-indicator" />}
            </Link>
          );

          if (item.perm) {
            return (
              <RequirePermission key={item.key} permission={item.perm}>
                {linkNode}
              </RequirePermission>
            );
          }

          return linkNode;
        })}
      </nav>

      <div className="sidebar-footer">
        <button className="sidebar-action-btn" onClick={handleToggleTheme} title="Toggle Theme">
          <div className="sidebar-icon">
            <i className={currentTheme === 'light' ? 'fas fa-moon' : 'fas fa-sun'}></i>
          </div>
          {!isCollapsed && <span className="sidebar-label" style={{ textTransform: 'capitalize' }}>Theme: {currentTheme}</span>}
        </button>
        
        <button className="sidebar-action-btn logout" onClick={() => signOut()} title="Logout">
          <div className="sidebar-icon">
            <i className="fas fa-sign-out-alt"></i>
          </div>
          {!isCollapsed && <span className="sidebar-label">Logout</span>}
        </button>
      </div>
    </aside>
  );
}
