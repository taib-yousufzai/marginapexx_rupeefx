'use client';

import React, { useEffect, useState } from 'react';
import './SplashScreen.css';

interface SplashScreenProps {
  onComplete: () => void;
  duration?: number; // ms
}

interface Particle {
  left: string;
  top: string;
  delay: string;
  dur: string;
}

export default function SplashScreen({ onComplete, duration = 3000 }: SplashScreenProps) {
  const [phase, setPhase] = useState<'visible' | 'fading'>('visible');
  const [particles, setParticles] = useState<Particle[]>([]);

  // Generate particles only on client to avoid hydration mismatch
  useEffect(() => {
    setParticles(
      Array.from({ length: 30 }).map(() => ({
        left: `${Math.random() * 100}%`,
        top: `${Math.random() * 100}%`,
        delay: `${Math.random() * 3}s`,
        dur: `${2 + Math.random() * 3}s`,
      }))
    );
  }, []);

  useEffect(() => {
    const fadeTimer = setTimeout(() => setPhase('fading'), duration - 600);
    const doneTimer = setTimeout(() => onComplete(), duration);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(doneTimer);
    };
  }, [duration, onComplete]);

  return (
    <div className={`splash-overlay ${phase === 'fading' ? 'splash-fade-out' : ''}`}>
      {/* Particle dots */}
      <div className="splash-particles">
        {particles.map((p, i) => (
          <div
            key={i}
            className="splash-particle"
            style={{ left: p.left, top: p.top, animationDelay: p.delay, animationDuration: p.dur }}
          />
        ))}
      </div>

      {/* Geometric lines background */}
      <div className="splash-geo-lines" />

      {/* Content */}
      <div className="splash-content">
        <div className="splash-image-wrapper">
          <img
            src="/splash-screen.jpg"
            alt="RupeeFx - Trade | Grow | Global"
            className="splash-image"
          />
        </div>
        <div className="splash-spinner-wrapper">
          <div className="splash-spinner" />
        </div>
      </div>
    </div>
  );
}
