import { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RupeeFX Trading',
    short_name: 'RupeeFX Trading',
    description: 'Advanced Trading App experience',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FFFFFF',
    theme_color: '#FFFFFF',
    icons: [
      {
        src: '/favicon-32.png?v=20',
        sizes: '32x32',
        type: 'image/png',
      },
      {
        src: '/icon-192x192.png?v=20',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512x512.png?v=20',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/loading-logo.jpg?v=20',
        sizes: '512x512',
        type: 'image/jpeg',
        purpose: 'any',
      },
    ],
  };
}
