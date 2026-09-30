'use client';

import React, { useEffect, useState } from 'react';
import './SplashScreen.css';

interface SplashScreenProps {
  onComplete: () => void;
  duration?: number; // ms
}

export default function SplashScreen({ onComplete, duration = 3000 }: SplashScreenProps) {
  const [phase, setPhase] = useState<'visible' | 'fading'>('visible');

  useEffect(() => {
    const fadeTimer = setTimeout(() => {
      setPhase('fading');
    }, duration - 600);

    const doneTimer = setTimeout(() => {
      onComplete();
    }, duration);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [duration, onComplete]);

  return (
    <div className={`splash-overlay ${phase === 'fading' ? 'splash-fade-out' : ''}`}>
      {/* Particle dots */}
      <div className="splash-particles">
        {Array.from({ length: 30 }).map((_, i) => (
          <div key={i} className="splash-particle" style={{
            left: `${Math.random() * 100}%`,
            top: `${Math.random() * 100}%`,
            animationDelay: `${Math.random() * 3}s`,
            animationDuration: `${2 + Math.random() * 3}s`,
          }} />
        ))}
      </div>

      {/* Geometric lines background */}
      <div className="splash-geo-lines" />

      {/* Content */}
      <div className="splash-content">
        {/* Main splash image (RupeeFx holographic globe design) */}
        <div className="splash-image-wrapper">
          <img
            src="/splash-screen.jpg"
            alt="RupeeFx - Trade | Grow | Global"
            className="splash-image"
          />
        </div>

        {/* Loading spinner */}
        <div className="splash-spinner-wrapper">
          <div className="splash-spinner" />
        </div>
      </div>
    </div>
  );
}
