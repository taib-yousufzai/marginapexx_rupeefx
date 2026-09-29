'use client';
import React, { useState } from 'react';
import SettingsScripts from './settings/SettingsScripts';
import SettingsTradingHours from './settings/SettingsTradingHours';
import SettingsCurrency from './settings/SettingsCurrency';
import SettingsApp from './settings/SettingsApp';
import SettingsBroadcaster from './settings/SettingsBroadcaster';
import SettingsFiltering from './settings/SettingsFiltering';
import WhatsAppPage from './WhatsAppPage';

type SettingsTab = 'scripts' | 'trading_hours' | 'currency' | 'app' | 'whatsapp' | 'broadcaster' | 'filtering';

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>('scripts');

  const renderActiveTab = () => {
    switch (activeTab) {
      case 'scripts':
        return <SettingsScripts />;
      case 'trading_hours':
        return <SettingsTradingHours />;
      case 'currency':
        return <SettingsCurrency />;
      case 'app':
        return <SettingsApp />;
      case 'whatsapp':
        return <WhatsAppPage />;
      case 'broadcaster':
        return <SettingsBroadcaster />;
      case 'filtering':
        return <SettingsFiltering />;
      default:
        return <SettingsScripts />;
    }
  };

  return (
    <div className="adm-settings-layout">
      {/* Settings Sidebar */}
      <div className="adm-settings-sidebar">
        <h2 className="adm-settings-title">
          System Settings
        </h2>
        
        <nav className="adm-settings-nav">
          <SidebarButton 
            active={activeTab === 'scripts'} 
            onClick={() => setActiveTab('scripts')}
            label="Script Settings"
          />
          <SidebarButton 
            active={activeTab === 'trading_hours'} 
            onClick={() => setActiveTab('trading_hours')}
            label="Trading Hours"
          />
          <SidebarButton 
            active={activeTab === 'currency'} 
            onClick={() => setActiveTab('currency')}
            label="Currency Settings"
          />
          <SidebarButton 
            active={activeTab === 'app'} 
            onClick={() => setActiveTab('app')}
            label="App Settings"
          />
          <SidebarButton 
            active={activeTab === 'whatsapp'} 
            onClick={() => setActiveTab('whatsapp')}
            label="WhatsApp Settings"
          />
          <SidebarButton 
            active={activeTab === 'broadcaster'} 
            onClick={() => setActiveTab('broadcaster')}
            label="Broadcaster"
          />
          <SidebarButton
            active={activeTab === 'filtering'}
            onClick={() => setActiveTab('filtering')}
            label="Filtering Settings"
          />
        </nav>
      </div>

      {/* Main Content Area */}
      <div className="adm-settings-main">
        {renderActiveTab()}
      </div>
    </div>
  );
}

function SidebarButton({ active, onClick, label }: { active: boolean, onClick: () => void, label: string }) {
  return (
    <button
      onClick={onClick}
      className={`adm-settings-btn ${active ? 'active' : ''}`}
    >
      {label}
    </button>
  );
}
