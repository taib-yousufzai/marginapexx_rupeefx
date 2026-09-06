-- ==========================================
-- NIVESHX TRADING: CREATE TRADE LOGS MIGRATION
-- Created: 2026-06-18
-- ==========================================

-- 1. Add webhook_token to public.profiles if not exists
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS webhook_token UUID DEFAULT gen_random_uuid();

-- 2. Create strategy_executions table
CREATE TABLE IF NOT EXISTS public.strategy_executions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  strategy_name TEXT NOT NULL,
  signal_type   TEXT NOT NULL, -- e.g., 'BUY', 'SELL', 'EXIT'
  symbol        TEXT NOT NULL,
  payload       JSONB NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
  error_message TEXT,
  order_id      UUID, -- Optional reference to orders
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Create trades table (tracks entry to exit cycle, synced with positions)
CREATE TABLE IF NOT EXISTS public.trades (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id           UUID, -- Reference back to positions table
  user_id               UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol                TEXT NOT NULL,
  side                  TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty                   NUMERIC NOT NULL,
  entry_price           NUMERIC NOT NULL,
  exit_price            NUMERIC,
  pnl                   NUMERIC NOT NULL DEFAULT 0,
  status                TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  entry_time            TIMESTAMPTZ NOT NULL DEFAULT now(),
  exit_time             TIMESTAMPTZ,
  strategy_execution_id UUID REFERENCES public.strategy_executions(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Create executions table (tracks individual order execution outcomes)
CREATE TABLE IF NOT EXISTS public.executions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id       UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  trade_id       UUID REFERENCES public.trades(id) ON DELETE SET NULL,
  user_id        UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol         TEXT NOT NULL,
  side           TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty            NUMERIC NOT NULL,
  price          NUMERIC NOT NULL,
  execution_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  commission     NUMERIC NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Create fills table (tracks transaction fill details)
CREATE TABLE IF NOT EXISTS public.fills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  execution_id  UUID NOT NULL REFERENCES public.executions(id) ON DELETE CASCADE,
  order_id      UUID NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty           NUMERIC NOT NULL,
  price         NUMERIC NOT NULL,
  fill_time     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. Setup Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_strategy_executions_user_id ON public.strategy_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_user_id ON public.trades(user_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON public.trades(status);
CREATE INDEX IF NOT EXISTS idx_executions_order_id ON public.executions(order_id);
CREATE INDEX IF NOT EXISTS idx_executions_user_id ON public.executions(user_id);
CREATE INDEX IF NOT EXISTS idx_fills_order_id ON public.fills(order_id);

-- 7. Enable RLS
ALTER TABLE public.strategy_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fills ENABLE ROW LEVEL SECURITY;

-- 8. Add Select Policies (authenticated users read their own records)
DROP POLICY IF EXISTS "Users can read own strategy_executions" ON public.strategy_executions;
CREATE POLICY "Users can read own strategy_executions" ON public.strategy_executions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own trades" ON public.trades;
CREATE POLICY "Users can read own trades" ON public.trades
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own executions" ON public.executions;
CREATE POLICY "Users can read own executions" ON public.executions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can read own fills" ON public.fills;
CREATE POLICY "Users can read own fills" ON public.fills
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- Add Service Role full access policies (for backend insert/update actions)
DROP POLICY IF EXISTS "Service role manages all strategy_executions" ON public.strategy_executions;
CREATE POLICY "Service role manages all strategy_executions" ON public.strategy_executions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages all trades" ON public.trades;
CREATE POLICY "Service role manages all trades" ON public.trades
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages all executions" ON public.executions;
CREATE POLICY "Service role manages all executions" ON public.executions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

DROP POLICY IF EXISTS "Service role manages all fills" ON public.fills;
CREATE POLICY "Service role manages all fills" ON public.fills
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- 9. Create Positions to Trades synchronization trigger
CREATE OR REPLACE FUNCTION public.sync_position_to_trade()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Check if trade already exists to prevent duplicate insertion
    IF NOT EXISTS (SELECT 1 FROM public.trades WHERE position_id = NEW.id) THEN
      INSERT INTO public.trades (
        id,
        position_id,
        user_id,
        symbol,
        side,
        qty,
        entry_price,
        status,
        entry_time,
        created_at,
        updated_at
      )
      VALUES (
        NEW.id,
        NEW.id,
        NEW.user_id,
        NEW.symbol,
        NEW.side,
        NEW.qty_total,
        NEW.entry_price,
        NEW.status,
        NEW.entry_time,
        NEW.created_at,
        NEW.updated_at
      );
    END IF;
  ELSIF TG_OP = 'UPDATE' THEN
    UPDATE public.trades
    SET
      status     = NEW.status,
      qty        = NEW.qty_total,
      exit_price = NEW.exit_price,
      exit_time  = NEW.exit_time,
      pnl        = NEW.pnl,
      updated_at = now()
    WHERE position_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS positions_sync_trade ON public.positions;
CREATE TRIGGER positions_sync_trade
  AFTER INSERT OR UPDATE ON public.positions
  FOR EACH ROW EXECUTE PROCEDURE public.sync_position_to_trade();

-- 10. Create Orders to Executions / Fills synchronization trigger
CREATE OR REPLACE FUNCTION public.sync_order_to_execution_fill()
RETURNS TRIGGER AS $$
DECLARE
  v_execution_id uuid;
  v_trade_id uuid;
BEGIN
  IF NEW.status = 'EXECUTED' AND (TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND OLD.status IS DISTINCT FROM 'EXECUTED')) THEN
    -- Link order execution to active trade (mapped by user and symbol)
    SELECT id INTO v_trade_id
    FROM public.trades
    WHERE user_id = NEW.user_id AND symbol = NEW.symbol
    ORDER BY created_at DESC
    LIMIT 1;

    -- Avoid double insertion for same order execution
    IF NOT EXISTS (SELECT 1 FROM public.executions WHERE order_id = NEW.id) THEN
      INSERT INTO public.executions (
        order_id,
        trade_id,
        user_id,
        symbol,
        side,
        qty,
        price,
        execution_time,
        commission,
        created_at
      )
      VALUES (
        NEW.id,
        v_trade_id,
        NEW.user_id,
        NEW.symbol,
        NEW.side,
        NEW.qty,
        COALESCE(NEW.fill_price, NEW.price),
        COALESCE(NEW.created_at, now()),
        COALESCE(NEW.brokerage, 0),
        now()
      )
      RETURNING id INTO v_execution_id;

      INSERT INTO public.fills (
        execution_id,
        order_id,
        user_id,
        symbol,
        side,
        qty,
        price,
        fill_time,
        created_at
      )
      VALUES (
        v_execution_id,
        NEW.id,
        NEW.user_id,
        NEW.symbol,
        NEW.side,
        NEW.qty,
        COALESCE(NEW.fill_price, NEW.price),
        COALESCE(NEW.created_at, now()),
        now()
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS orders_sync_execution ON public.orders;
CREATE TRIGGER orders_sync_execution
  AFTER INSERT OR UPDATE ON public.orders
  FOR EACH ROW EXECUTE PROCEDURE public.sync_order_to_execution_fill();
