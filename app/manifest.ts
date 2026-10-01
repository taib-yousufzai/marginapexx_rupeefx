import { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'RupeeFX Trading',
    short_name: 'RupeeFX Trading',
    description: 'Advanced Trading App experience',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#000000',
    theme_color: '#000000',
    icons: [
      {
        src: '/favicon-32.png?v=25',
        sizes: '32x32',
        type: 'image/png',
      },
      {
        src: '/icon-192x192.png?v=25',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512x512.png?v=25',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  };
}
