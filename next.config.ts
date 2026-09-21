import type { NextConfig } from "next";
import withSerwistInit from "@serwist/next";

const withSerwist = withSerwistInit({
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  disable: process.env.NODE_ENV === "development",
});

const nextConfig: NextConfig = {
  // Disable standalone output when deploying to Vercel so Vercel's serverless build tracer finds next-server.js.nft.json
  output: process.env.VERCEL ? undefined : 'standalone',
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  experimental: {
    scrollRestoration: false,
  },
  turbopack: {},
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: '/charting_library/:path*',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
        ],
      },
    ];
  },
};

export default withSerwist(nextConfig);
