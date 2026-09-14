import { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Margin Apex',
    short_name: 'Margin Apex',
    description: 'Advanced Trading App experience',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#FFFFFF',
    theme_color: '#FFFFFF',
    icons: [
      {
        src: '/favicon-32.png?v=10',
        sizes: '32x32',
        type: 'image/png',
      },
      {
        src: '/icon-192x192.png?v=12',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512x512.png?v=12',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/loading-logo.jpg?v=7',
        sizes: '512x512',
        type: 'image/jpeg',
        purpose: 'any',
      },
    ],
  };
}
