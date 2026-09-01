-- Update US Stocks (us-eq) and Crypto trading hours to end at 00:00 (12:00 AM IST)

INSERT INTO public.trading_hours (id, name, start_time, end_time, is_active)
VALUES ('us-eq', 'US Stocks', '00:00', '00:00', true)
ON CONFLICT (id) DO UPDATE SET
  start_time = '00:00',
  end_time   = '00:00',
  is_active  = true;

UPDATE public.trading_hours
SET end_time = '00:00'
WHERE id IN ('crypto', 'us-eq');
