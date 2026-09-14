import { NextRequest, NextResponse } from 'next/server';
import { telemetry } from '@/lib/metrics';
import { getUserFromRequest } from '@/lib/adminClient';

const TICKER_METRICS_URL = process.env.TICKER_METRICS_URL || 'http://localhost:8080/metrics';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const start = performance.now();
  try {
    const user = await getUserFromRequest(request);
    if (!user) {
      telemetry.recordApiCall('/api/admin/metrics', performance.now() - start, false);
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Try to fetch live metrics directly from the Ticker Daemon process
    let summary: any = null;
    let tickerOnline = false;
    try {
      const tickerRes = await fetch(TICKER_METRICS_URL, {
        signal: AbortSignal.timeout(1500), // 1.5s timeout
      });
      if (tickerRes.ok) {
        summary = await tickerRes.json();
        tickerOnline = true;
      }
    } catch (_err) {
      // Ticker offline — will fall back to local process telemetry below
    }

    if (!summary) {
      summary = telemetry.getSummary();
    }

    // Enrich with infrastructure metrics from THIS process (Next.js server)
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();

    const responseData = {
      ...summary,
      tickerOnline,
      infrastructure: {
        memory: {
          heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
          heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
          rssMb: Math.round(memory.rss / 1024 / 1024),
        },
        cpu: {
          user: cpu.user,
          system: cpu.system
        },
        uptime: process.uptime()
      }
    };

    telemetry.recordApiCall('/api/admin/metrics', performance.now() - start, true);
    return NextResponse.json(responseData);
  } catch (err: any) {
    console.error('Error fetching admin metrics:', err);
    telemetry.recordApiCall('/api/admin/metrics', performance.now() - start, false);
    return NextResponse.json({ error: 'Failed to fetch metrics', details: err?.message || err }, { status: 500 });
  }
}
