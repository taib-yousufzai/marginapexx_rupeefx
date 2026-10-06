import React from 'react';

interface AnimatedLoaderProps {
  text?: string;
  fullScreen?: boolean;
  size?: 'small' | 'medium' | 'large';
}

export default function AnimatedLoader({ text, fullScreen = false, size = 'large' }: AnimatedLoaderProps) {
  const isSmall = size === 'small';
  const barWidth = isSmall ? '4px' : '6px';
  const barHeight = isSmall ? '20px' : '32px';
  const gap = isSmall ? '4px' : '6px';

  const loaderContent = (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: isSmall ? '10px' : '16px',
      background: 'rgba(17, 24, 39, 0.90)',
      padding: isSmall ? '16px 24px' : '24px 36px',
      borderRadius: '20px',
      boxShadow: '0 20px 40px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255, 255, 255, 0.12)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      minWidth: isSmall ? '160px' : '220px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: gap, height: barHeight }}>
        <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#3B82F6', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.3s' }} />
        <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#10B981', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '-0.15s' }} />
        <div style={{ width: barWidth, height: '100%', borderRadius: '4px', background: '#6366F1', animation: 'bm-pulse 1s ease-in-out infinite', animationDelay: '0s' }} />
      </div>
      {text && <div style={{ fontSize: isSmall ? '13px' : '15px', fontWeight: 700, color: '#ffffff', letterSpacing: '0.3px', textAlign: 'center' }}>{text}</div>}
      <style dangerouslySetInnerHTML={{ __html: `@keyframes bm-pulse { 0%, 100% { transform: scaleY(0.35); opacity: 0.4; } 50% { transform: scaleY(1.1); opacity: 1; } }` }} />
    </div>
  );

  if (fullScreen) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        zIndex: 9999999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)'
      }}>
        {loaderContent}
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', minHeight: '150px' }}>
      {loaderContent}
    </div>
  );
}
