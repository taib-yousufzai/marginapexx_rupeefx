import type { Metadata, Viewport } from 'next';
import './globals.css';
import InstallPrompt from '@/components/InstallPrompt';
import { MarketDataProvider } from '@/contexts/MarketDataContext';
import { BinanceDataProvider } from '@/contexts/BinanceDataContext';
import { ComexDataProvider } from '@/contexts/ComexDataContext';
import { TradeConfigProvider } from '@/contexts/TradeConfigContext';
import { PositionsDataProvider } from '@/contexts/PositionsContext';
import { OrdersDataProvider } from '@/contexts/OrdersContext';
import { BalanceDataProvider } from '@/contexts/BalanceContext';
import ClientShell from '@/components/ClientShell';
export const viewport: Viewport = {
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#1E1E1E' }],
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover'
};

export const metadata: Metadata = {
  title: 'Margin Apex',
  description: 'Clean Icons & Trading App UI',
  manifest: '/manifest.webmanifest?v=9',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Margin Apex'
  },
  formatDetection: {
    telephone: false
  }
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Preload the charting library so it's ready before the chart component mounts */}
        <link rel="preload" href="/charting_library/charting_library.standalone.js" as="script" />
        {/* DNS prefetch for external CDNs */}
        <link rel="preconnect" href="https://cdnjs.cloudflare.com" />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* Font Awesome 6 */}
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" />
        {/* Tabler Icons */}
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@latest/tabler-icons.min.css" />
        {/* Google Fonts: Playfair Display + Inter */}
        <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,300;14..32,400;14..32,500;14..32,600;14..32,700;14..32,800&family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400;1,500;1,600;1,700;1,800;1,900&display=swap" rel="stylesheet" />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('marginApexTheme')||'light';document.documentElement.classList.remove('dark','black','blue','light');document.documentElement.classList.add(t);document.documentElement.setAttribute('data-theme',t);var o=new MutationObserver(function(m,obs){if(document.body){document.body.classList.remove('dark','black','blue','light');document.body.classList.add(t);document.body.setAttribute('data-theme',t);obs.disconnect();}});o.observe(document.documentElement,{childList:true});}catch(e){}if('scrollRestoration' in history)history.scrollRestoration='manual';})();`
          }}
        />
      </head>
      <body suppressHydrationWarning>
        <MarketDataProvider>
          <BinanceDataProvider>
            <ComexDataProvider>
              <TradeConfigProvider>
                <PositionsDataProvider>
                  <OrdersDataProvider>
                    <BalanceDataProvider>
                      <ClientShell>
                        {children}
                      </ClientShell>
                      <InstallPrompt />
                    </BalanceDataProvider>
                  </OrdersDataProvider>
                </PositionsDataProvider>
              </TradeConfigProvider>
            </ComexDataProvider>
          </BinanceDataProvider>
        </MarketDataProvider>
      </body>
    </html>
  );
}
