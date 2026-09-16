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
        {/* Critical Theme CSS - prevents any white flash during initial document parse */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html.dark, html[data-theme="dark"], html.dark body, body.dark { background-color: #121212 !important; color: #FFFFFF; }
              html.black, html[data-theme="black"], html.black body, body.black { background-color: #000000 !important; color: #FFFFFF; }
              html.blue, html[data-theme="blue"], html.blue body, body.blue { background-color: #0A1128 !important; color: #FFFFFF; }
              html.light, html[data-theme="light"], html.light body, body.light { background-color: #F0F2F5 !important; color: #1A1A1A; }
            `
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('marginApexTheme')||'light';var doc=document.documentElement;doc.classList.remove('dark','black','blue','light');doc.classList.add(t);doc.setAttribute('data-theme',t);var bg=t==='black'?'#000000':(t==='dark'?'#121212':(t==='blue'?'#0A1128':'#F0F2F5'));doc.style.backgroundColor=bg;var o=new MutationObserver(function(m,obs){if(document.body){document.body.classList.remove('dark','black','blue','light');document.body.classList.add(t);document.body.setAttribute('data-theme',t);document.body.style.backgroundColor=bg;obs.disconnect();}});o.observe(doc,{childList:true});}catch(e){}if('scrollRestoration' in history)history.scrollRestoration='manual';})();`
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
