'use client';
import React, { useState, useEffect } from 'react';

export default function SplashLoader() {
  const [fading, setFading] = useState(false);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    // Start fading out after 600ms
    const fadeTimer = setTimeout(() => {
      setFading(true);

      // Mark as hidden after 300ms transition completes
      const hideTimer = setTimeout(() => {
        setHidden(true);
      }, 300);

      return () => clearTimeout(hideTimer);
    }, 600);

    return () => clearTimeout(fadeTimer);
  }, []);

  return (
    <div
      id="app-splash-screen"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: '#000000',
        zIndex: 99999,
        display: hidden ? 'none' : 'flex',
        justifyContent: 'center',
        alignItems: 'flex-start',
        paddingTop: '35vh',
        transition: 'opacity 0.3s ease, visibility 0.3s ease',
        opacity: fading ? 0 : 1,
        visibility: fading ? 'hidden' : 'visible',
        pointerEvents: 'none',
      }}
    >
      <img
        src="/rupeefx-original-logo.png"
        alt="RupeeFx Logo"
        style={{
          width: '320px',
          maxWidth: '85vw',
          height: 'auto',
          objectFit: 'contain'
        }}
      />
    </div>
  );
}
