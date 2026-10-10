-- ==============================================================================
-- RAILWAY POSTGRESQL TRADING ENGINE SETUP
-- Pristine high-performance schema and functions for sub-15ms order execution.
-- ==============================================================================

-- 1. PROFILES TABLE (Wallet Balance & Trading State)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY,
  active boolean DEFAULT true,
  role text DEFAULT 'USER',
  balance numeric NOT NULL DEFAULT 0,
  settlement_amount numeric NOT NULL DEFAULT 0,
  trading_mode text DEFAULT 'standard',
  parent_id uuid,
  template_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_railway_profiles_parent ON public.profiles (parent_id);

-- 2. ORDERS TABLE
CREATE TABLE IF NOT EXISTS public.orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  kite_instrument text,
  segment text,
  side text NOT NULL CHECK (side in ('BUY','SELL')),
  status text NOT NULL CHECK (status in ('PENDING','EXECUTED','CANCELLED','REJECTED','FAILED','TRIGGER_PENDING')),
  qty numeric NOT NULL,
  lots numeric DEFAULT 0,
  price numeric NOT NULL,
  fill_price numeric,
  ltp_at_entry numeric,
  order_type text NOT NULL,
  product_type text DEFAULT 'INTRADAY',
  info text,
  is_exit boolean DEFAULT false,
  trigger_price numeric,
  stop_loss numeric,
  target numeric,
  buffer_fee numeric NOT NULL DEFAULT 0,
  brokerage numeric NOT NULL DEFAULT 0,
  idempotency_key text,
  linked_position_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_railway_orders_user_id ON public.orders (user_id);
CREATE INDEX IF NOT EXISTS idx_railway_orders_status ON public.orders (status);
CREATE INDEX IF NOT EXISTS idx_railway_orders_symbol ON public.orders (symbol);
CREATE INDEX IF NOT EXISTS idx_railway_orders_user_status ON public.orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_railway_orders_idempotency ON public.orders (user_id, idempotency_key);

-- 3. POSITIONS TABLE
CREATE TABLE IF NOT EXISTS public.positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  symbol text NOT NULL,
  side text NOT NULL CHECK (side in ('BUY','SELL')),
  status text NOT NULL,
  pnl numeric NOT NULL DEFAULT 0,
  qty_open numeric NOT NULL DEFAULT 0,
  qty_total numeric NOT NULL DEFAULT 0,
  avg_price numeric NOT NULL DEFAULT 0,
  entry_price numeric NOT NULL DEFAULT 0,
  ltp numeric,
  exit_price numeric,
  duration_seconds integer NOT NULL DEFAULT 0,
  brokerage numeric NOT NULL DEFAULT 0,
  entry_brokerage numeric NOT NULL DEFAULT 0,
  sl numeric,
  tp numeric,
  stop_loss numeric,
  target numeric,
  locked_margin numeric DEFAULT 0,
  margin_required numeric DEFAULT 0,
  lots numeric DEFAULT 0,
  product_type text DEFAULT 'INTRADAY',
  settlement text,
  carry_brokerage_paid boolean DEFAULT false,
  closed_by text DEFAULT 'USER',
  is_closed boolean DEFAULT false,
  entry_time timestamptz NOT NULL DEFAULT now(),
  exit_time timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS carry_brokerage_paid boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_railway_positions_user_id ON public.positions (user_id);
CREATE INDEX IF NOT EXISTS idx_railway_positions_status ON public.positions (status);
CREATE INDEX IF NOT EXISTS idx_railway_positions_user_status ON public.positions (user_id, status);
CREATE INDEX IF NOT EXISTS idx_railway_positions_symbol ON public.positions (symbol);
CREATE INDEX IF NOT EXISTS idx_railway_positions_user_symbol_status ON public.positions (user_id, symbol, status);

-- 4. TRANSACTIONS TABLE (Ledger)
CREATE TABLE IF NOT EXISTS public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  type text NOT NULL,
  amount numeric NOT NULL,
  status text NOT NULL DEFAULT 'APPROVED',
  ref_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_railway_transactions_user_id ON public.transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_railway_transactions_ref_id ON public.transactions (ref_id);

-- 5. CANONICAL SYMBOL FUNCTION (clean_symbol_v2)
CREATE OR REPLACE FUNCTION public.clean_symbol_v2(p_sym text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_clean text;
BEGIN
    IF p_sym IS NULL OR p_sym = '' THEN
        RETURN '';
    END IF;

    -- Strip exchange prefixes
    v_clean := regexp_replace(p_sym, '^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)', '', 'i');
    v_clean := regexp_replace(v_clean, '[\/\s\_\-]', '', 'g');
    v_clean := regexp_replace(v_clean, '(PERP|\.P|FUT)$', '', 'i');
    v_clean := UPPER(v_clean);

    IF v_clean IN ('XAUUSD', 'GC=F', 'GC', 'GOLD') THEN
        RETURN 'XAUUSD';
    ELSIF v_clean IN ('XAGUSD', 'SI=F', 'SI', 'SILVER') THEN
        RETURN 'XAGUSD';
    ELSIF v_clean IN ('XTIUSD', 'CL=F', 'CL', 'WTI', 'CRUDE', 'CRUDEOIL') THEN
        RETURN 'XTIUSD';
    ELSIF v_clean IN ('XCUUSD', 'HG=F', 'HG', 'COPPER') THEN
        RETURN 'XCUUSD';
    ELSIF v_clean IN ('XNGUSD', 'NG=F', 'NG', 'NATGAS', 'NATURALGAS') THEN
        RETURN 'XNGUSD';
    END IF;

    IF v_clean IN ('DODGE', 'DODGEUSDT', 'DOGE', 'DOGEUSDT') THEN
        RETURN 'DOGEUSDT';
    END IF;

    IF v_clean ~ '^(BTC|ETH|DOGE|SOL|XRP|ADA|BNB|DOT|LTC|AVAX|MATIC|LINK|UNI|BCH|SHIB|PEPE|TRX|NEAR|SUI|APT|FET|RNDR|INJ|TIA|OP|ARB)$' THEN
        RETURN v_clean || 'USDT';
    END IF;

    IF v_clean ~ 'USDT$' THEN
        RETURN v_clean;
    END IF;

    IF v_clean ~ 'USD$' AND NOT (v_clean IN ('GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF')) THEN
        RETURN regexp_replace(v_clean, 'USD$', 'USDT');
    END IF;

    RETURN v_clean;
END;
$$;

-- 6. CREATE POSITION INTERNAL FUNCTION
CREATE OR REPLACE FUNCTION public.create_position_internal(
  p_user_id        uuid,
  p_symbol         text,
  p_side           text,
  p_qty            numeric,
  p_price          numeric,
  p_ltp            numeric,
  p_product_type   text,
  p_settlement     text,
  p_stop_loss      numeric,
  p_target         numeric,
  p_locked_margin  numeric,
  p_margin_required numeric,
  p_brokerage      numeric
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    v_position_id uuid;
BEGIN
    INSERT INTO public.positions (
        user_id, symbol, side, status, qty_open, qty_total, avg_price, entry_price, ltp,
        product_type, settlement, stop_loss, target, locked_margin, margin_required,
        entry_brokerage, brokerage, entry_time, created_at, updated_at, is_closed
    ) VALUES (
        p_user_id, p_symbol, p_side, 'open', p_qty, p_qty, p_price, p_price, p_ltp,
        p_product_type, p_settlement, p_stop_loss, p_target, p_locked_margin, p_margin_required,
        p_brokerage, p_brokerage, now(), now(), now(), false
    ) RETURNING id INTO v_position_id;

    RETURN v_position_id;
END;
$$;

-- 7. CLOSE POSITION V2 FUNCTION
CREATE OR REPLACE FUNCTION public.close_position_v2(
  p_position_id        uuid,
  p_close_qty          numeric,
  p_close_price        numeric,
  p_closed_by          text,
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key    text DEFAULT NULL::text,
  p_skip_cancel_orders boolean DEFAULT false
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
    v_user_id uuid;
    v_symbol text;
    v_side text;
    v_qty_open numeric;
    v_avg_price numeric;
    v_locked_margin numeric;
    v_margin_required numeric;
    v_settlement text;
    v_product_type text;
    
    v_pnl numeric;
    v_margin_released numeric;
    v_pnl_type text;
    v_exit_side text;
    
    v_lot_size numeric;
    v_lots numeric;
    v_order_exists boolean := false;
BEGIN
    -- Idempotency check
    IF p_idempotency_key IS NOT NULL THEN
        SELECT 
          CASE WHEN type = 'PNL_CREDIT' THEN amount ELSE -amount END INTO v_pnl
        FROM public.transactions
        WHERE ref_id = 'CLOSE_PNL_' || p_idempotency_key;
        
        IF FOUND THEN
            RETURN v_pnl;
        END IF;
    END IF;

    -- Lock Position
    SELECT user_id, symbol, side, qty_open, avg_price, locked_margin, margin_required, settlement, product_type
    INTO v_user_id, v_symbol, v_side, v_qty_open, v_avg_price, v_locked_margin, v_margin_required, v_settlement, v_product_type
    FROM public.positions
    WHERE id = p_position_id AND LOWER(status) IN ('open', 'active')
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found or already closed.';
    END IF;

    -- Lock Profile
    PERFORM 1 FROM public.profiles WHERE id = v_user_id FOR UPDATE;

    IF p_close_qty <= 0 THEN
        RAISE EXCEPTION 'Close quantity must be greater than 0.';
    END IF;

    IF p_close_qty > v_qty_open THEN
        RAISE EXCEPTION 'Cannot close more than open quantity (%). Requested: %', v_qty_open, p_close_qty;
    END IF;

    -- Calculate Realized PnL
    IF v_symbol ILIKE '%GOLD%' THEN
        IF v_side = 'BUY' THEN
            v_pnl := (p_close_price - v_avg_price) * p_close_qty * 0.1;
        ELSE
            v_pnl := (v_avg_price - p_close_price) * p_close_qty * 0.1;
        END IF;
    ELSE
        IF v_side = 'BUY' THEN
            v_pnl := (p_close_price - v_avg_price) * p_close_qty;
        ELSE
            v_pnl := (v_avg_price - p_close_price) * p_close_qty;
        END IF;
    END IF;

    v_exit_side := CASE WHEN v_side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
    IF p_close_qty = v_qty_open THEN
        v_margin_released := v_locked_margin;
    ELSE
        v_margin_released := round((v_locked_margin * p_close_qty) / v_qty_open, 2);
    END IF;

    -- Update Position
    UPDATE public.positions
    SET 
        qty_open = qty_open - p_close_qty,
        locked_margin = GREATEST(0, locked_margin - v_margin_released),
        margin_required = GREATEST(0, margin_required - v_margin_released),
        exit_price = p_close_price,
        exit_time = now(),
        closed_by = p_closed_by,
        status = CASE WHEN (qty_open - p_close_qty) <= 0 THEN 'closed' ELSE 'active' END,
        is_closed = (qty_open - p_close_qty) <= 0,
        pnl = pnl + v_pnl,
        brokerage = brokerage + p_expected_brokerage,
        updated_at = now()
    WHERE id = p_position_id;

    -- Update Profile Balance
    UPDATE public.profiles
    SET balance = balance + v_pnl - p_expected_brokerage,
        updated_at = now()
    WHERE id = v_user_id;

    -- Check if an order already exists for this idempotency key
    IF p_idempotency_key IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1 FROM public.orders 
            WHERE idempotency_key = p_idempotency_key OR id::text = p_idempotency_key
        ) INTO v_order_exists;
    END IF;

    -- Insert exit order if not already created
    IF NOT v_order_exists THEN
        INSERT INTO public.orders (
            user_id, symbol, side, status, qty, lots, price, fill_price,
            order_type, product_type, info, is_exit, buffer_fee, brokerage, idempotency_key, ltp_at_entry
        ) VALUES (
            v_user_id, v_symbol, v_symbol, v_exit_side, 'EXECUTED', p_close_qty, 0, p_close_price, p_close_price,
            'MARKET', COALESCE(v_product_type, 'INTRADAY'), p_position_id::text, true, 0, p_expected_brokerage,
            COALESCE(p_idempotency_key, p_position_id::text || '_' || now()::text), p_close_price
        );
    END IF;

    -- Write to Ledger
    IF p_expected_brokerage > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', COALESCE('CLOSE_BRK_' || p_idempotency_key, 'BRK_' || p_position_id::text));
    END IF;

    IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', COALESCE('CLOSE_PNL_' || p_idempotency_key, 'PNL_' || p_position_id::text));
    END IF;

    IF v_margin_released > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'MARGIN_CREDIT', v_margin_released, 'APPROVED', COALESCE('CLOSE_MRG_' || p_idempotency_key, 'MRG_RET_' || p_position_id::text));
    END IF;

    RETURN v_pnl;
END;
$$;

-- 8. REDUCE POSITION INTERNAL FUNCTION
CREATE OR REPLACE FUNCTION public.reduce_position_internal(
  p_position_id        uuid,
  p_qty                numeric,
  p_price              numeric,
  p_ltp                numeric,
  p_expected_brokerage numeric,
  p_idempotency_key    text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
    v_user_id uuid;
    v_symbol text;
    v_side text;
    v_qty_open numeric;
    v_avg_price numeric;
    v_locked_margin numeric;
    v_margin_required numeric;
    v_settlement text;
    v_product_type text;
    v_stop_loss numeric;
    v_target numeric;
    v_entry_time timestamptz;
    
    v_pnl numeric;
    v_margin_released numeric;
    v_pnl_type text;
BEGIN
    SELECT user_id INTO v_user_id FROM public.positions WHERE id = p_position_id;
    IF v_user_id IS NOT NULL THEN
        PERFORM 1 FROM public.profiles WHERE id = v_user_id FOR UPDATE;
    END IF;

    SELECT user_id, symbol, side, qty_open, avg_price, locked_margin, margin_required,
           settlement, product_type, stop_loss, target, entry_time
    INTO v_user_id, v_symbol, v_side, v_qty_open, v_avg_price, v_locked_margin, v_margin_required,
         v_settlement, v_product_type, v_stop_loss, v_target, v_entry_time
    FROM public.positions
    WHERE id = p_position_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found for reduction.';
    END IF;

    IF p_qty <= 0 THEN
        RAISE EXCEPTION 'Reduction quantity must be greater than 0.';
    END IF;

    IF p_qty >= v_qty_open THEN
        RAISE EXCEPTION 'Reduction quantity cannot exceed or equal open quantity (%). Use close_position_v2 instead.', v_qty_open;
    END IF;

    IF v_symbol ILIKE '%GOLD%' THEN
        IF v_side = 'BUY' THEN
            v_pnl := (p_price - v_avg_price) * p_qty * 0.1;
        ELSE
            v_pnl := (v_avg_price - p_price) * p_qty * 0.1;
        END IF;
    ELSE
        IF v_side = 'BUY' THEN
            v_pnl := (p_price - v_avg_price) * p_qty;
        ELSE
            v_pnl := (v_avg_price - p_price) * p_qty;
        END IF;
    END IF;

    v_margin_released := round((v_locked_margin * p_qty) / v_qty_open, 2);

    UPDATE public.positions
    SET qty_open = qty_open - p_qty,
        qty_total = GREATEST(qty_total - p_qty, qty_open - p_qty),
        locked_margin = locked_margin - v_margin_released,
        margin_required = margin_required - v_margin_released,
        updated_at = now()
    WHERE id = p_position_id;

    UPDATE public.profiles
    SET balance = balance + v_pnl - p_expected_brokerage,
        updated_at = now()
    WHERE id = v_user_id;

    IF p_expected_brokerage > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', COALESCE('RED_BRK_' || p_idempotency_key, 'BRK_PARTIAL_' || p_position_id::text));
    END IF;

    IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', COALESCE('RED_PNL_' || p_idempotency_key, 'PNL_PARTIAL_' || p_position_id::text));
    END IF;

    IF v_margin_released > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'MARGIN_CREDIT', v_margin_released, 'APPROVED', COALESCE('RED_MRG_' || p_idempotency_key, 'MRG_PARTIAL_' || p_position_id::text));
    END IF;

    RETURN v_pnl;
END;
$$;

-- 9. PLACE ORDER V2 FUNCTION
CREATE OR REPLACE FUNCTION public.place_order_v2(
  p_user_id        uuid,
  p_symbol         text,
  p_kite_inst      text,
  p_segment        text,
  p_side           text,
  p_order_type     text,
  p_product_type   text,
  p_qty            numeric,
  p_lots           numeric,
  p_ltp            numeric,
  p_fill_price     numeric,
  p_is_exit        boolean,
  p_buffer_fee     numeric,
  p_status         text,
  p_trigger_price  numeric DEFAULT NULL::numeric,
  p_stop_loss      numeric DEFAULT NULL::numeric,
  p_target         numeric DEFAULT NULL::numeric,
  p_info           text DEFAULT NULL::text,
  p_expected_margin numeric DEFAULT 0,
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key text DEFAULT NULL::text,
  p_linked_position_id uuid DEFAULT NULL::uuid
)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
    v_order_id uuid;
    v_profile_balance numeric;
    v_position_id uuid;
    v_pos RECORD;
    v_pos_qty_open numeric;
    v_pos_side text;
    v_remaining_qty numeric;
    v_closed_qty numeric;
BEGIN
    -- Idempotency check
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_order_id 
        FROM public.orders 
        WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
        LIMIT 1;
        IF FOUND THEN
            RETURN v_order_id;
        END IF;
    END IF;

    -- Validate Margin & Balance
    SELECT balance INTO v_profile_balance
    FROM public.profiles
    WHERE id = p_user_id
    FOR UPDATE;

    IF v_profile_balance IS NULL THEN
        -- Auto-seed profile if not exists
        INSERT INTO public.profiles (id, balance) VALUES (p_user_id, 100000)
        ON CONFLICT (id) DO NOTHING;
        v_profile_balance := 100000;
    END IF;

    IF v_profile_balance < (p_expected_margin + p_expected_brokerage + p_buffer_fee) AND p_is_exit = false THEN
        RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_profile_balance, (p_expected_margin + p_expected_brokerage + p_buffer_fee);
    END IF;

    -- Insert Order
    BEGIN
        INSERT INTO public.orders (
            user_id, symbol, kite_instrument, segment, side, status, qty, lots, price, fill_price,
            order_type, product_type, info, is_exit, trigger_price, stop_loss, target, buffer_fee, brokerage, idempotency_key, ltp_at_entry
        ) VALUES (
            p_user_id, p_symbol, p_kite_inst, p_segment, p_side, p_status, p_qty, p_lots, p_fill_price, p_fill_price,
            p_order_type, p_product_type, COALESCE(p_info, p_linked_position_id::text), p_is_exit, p_trigger_price, p_stop_loss, p_target, p_buffer_fee, p_expected_brokerage, p_idempotency_key, p_ltp
        ) RETURNING id INTO v_order_id;
    EXCEPTION WHEN unique_violation THEN
        SELECT id INTO v_order_id 
        FROM public.orders 
        WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
        LIMIT 1;
        
        IF FOUND THEN
            RETURN v_order_id;
        ELSE
            RAISE;
        END IF;
    END;

    IF p_idempotency_key IS NULL THEN
        UPDATE public.orders SET idempotency_key = v_order_id::text WHERE id = v_order_id;
    END IF;

    -- Process execution into Positions
    IF p_status = 'EXECUTED' THEN
        IF p_is_exit THEN
            IF p_linked_position_id IS NOT NULL THEN
                SELECT side, product_type, symbol
                INTO v_pos_side, p_product_type, p_symbol
                FROM public.positions
                WHERE id = p_linked_position_id AND LOWER(status) IN ('open', 'active');
            END IF;

            SELECT side, COALESCE(SUM(qty_open), 0)
            INTO v_pos_side, v_pos_qty_open
            FROM public.positions
            WHERE user_id = p_user_id 
              AND (
                symbol = p_symbol 
                OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(p_symbol)
              )
              AND LOWER(status) IN ('open', 'active')
              AND side <> p_side
            GROUP BY side
            LIMIT 1;

            IF v_pos_qty_open IS NULL OR v_pos_qty_open <= 0 THEN
                RAISE EXCEPTION 'No open position exists to exit.';
            END IF;

            IF p_qty > v_pos_qty_open THEN
                RAISE EXCEPTION 'Exit quantity (%) exceeds total open position quantity (%).', p_qty, v_pos_qty_open;
            END IF;
        END IF;

        IF p_linked_position_id IS NOT NULL THEN
            SELECT id, qty_open, side, product_type, symbol
            INTO v_position_id, v_pos_qty_open, v_pos_side, p_product_type, p_symbol
            FROM public.positions
            WHERE id = p_linked_position_id AND LOWER(status) IN ('open', 'active')
            LIMIT 1
            FOR UPDATE;
        END IF;

        IF v_position_id IS NULL AND p_is_exit = true THEN
            SELECT id, qty_open, side, product_type, symbol
            INTO v_position_id, v_pos_qty_open, v_pos_side, p_product_type, p_symbol
            FROM public.positions
            WHERE user_id = p_user_id 
              AND (
                symbol = p_symbol 
                OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(p_symbol)
              )
              AND LOWER(status) IN ('open', 'active')
              AND side <> p_side
            ORDER BY entry_time DESC
            LIMIT 1
            FOR UPDATE;
        END IF;

        -- Create new lot or FIFO exit
        IF (p_is_exit IS NOT TRUE) AND (v_position_id IS NULL OR v_pos_side = p_side) THEN
            v_position_id := public.create_position_internal(
                p_user_id, p_symbol, p_side, p_qty, p_fill_price, p_ltp,
                p_product_type, p_segment, p_stop_loss, p_target,
                p_expected_margin, p_expected_margin, p_expected_brokerage
            );
            UPDATE public.orders SET info = v_position_id::text WHERE id = v_order_id;

            IF p_expected_margin > 0 THEN
                INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
                VALUES (p_user_id, 'MARGIN_DEBIT', p_expected_margin, 'APPROVED', 'MRG_' || v_order_id::text);
            END IF;
        ELSE
            -- FIFO Opposite Netting
            v_remaining_qty := p_qty;

            IF p_linked_position_id IS NOT NULL THEN
                FOR v_pos IN 
                    SELECT id, qty_open 
                    FROM public.positions
                    WHERE id = p_linked_position_id AND LOWER(status) IN ('open', 'active') AND side = v_pos_side
                    FOR UPDATE
                LOOP
                    IF v_remaining_qty <= 0 THEN EXIT; END IF;
                    
                    IF v_pos.qty_open > v_remaining_qty THEN
                        v_closed_qty := v_remaining_qty;
                        PERFORM public.reduce_position_internal(
                            v_pos.id, v_closed_qty, p_fill_price, p_ltp,
                            round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            COALESCE(p_idempotency_key, v_order_id::text) || '_' || v_pos.id::text
                        );
                        v_remaining_qty := 0;
                    ELSE
                        v_closed_qty := v_pos.qty_open;
                        PERFORM public.close_position_v2(
                            v_pos.id, v_closed_qty, p_fill_price,
                            'FIFO_EXIT', round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            v_order_id::text, true
                        );
                        v_remaining_qty := v_remaining_qty - v_closed_qty;
                    END IF;
                END LOOP;
            END IF;

            IF v_remaining_qty > 0 THEN
                FOR v_pos IN 
                    SELECT id, qty_open 
                    FROM public.positions
                    WHERE user_id = p_user_id 
                      AND (
                        symbol = p_symbol 
                        OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(p_symbol)
                      )
                      AND LOWER(status) IN ('open', 'active')
                      AND side = v_pos_side
                      AND (p_linked_position_id IS NULL OR id != p_linked_position_id)
                    ORDER BY entry_time ASC, qty_open ASC, id ASC
                    FOR UPDATE
                LOOP
                    IF v_remaining_qty <= 0 THEN EXIT; END IF;
    
                    IF v_pos.qty_open > v_remaining_qty THEN
                        v_closed_qty := v_remaining_qty;
                        PERFORM public.reduce_position_internal(
                            v_pos.id, v_closed_qty, p_fill_price, p_ltp,
                            round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            COALESCE(p_idempotency_key, v_order_id::text) || '_' || v_pos.id::text
                        );
                        v_remaining_qty := 0;
                    ELSE
                        v_closed_qty := v_pos.qty_open;
                        PERFORM public.close_position_v2(
                            v_pos.id, v_closed_qty, p_fill_price,
                            'FIFO_EXIT', round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            COALESCE(p_idempotency_key, v_order_id::text) || '_' || v_pos.id::text, true
                        );
                        v_remaining_qty := v_remaining_qty - v_closed_qty;
                    END IF;
                END LOOP;
            END IF;
        END IF;

        -- Cancel opposite pending triggers if position fully closed
        IF p_is_exit AND p_linked_position_id IS NOT NULL THEN
            UPDATE public.orders 
            SET status = 'CANCELLED', updated_at = now()
            WHERE user_id = p_user_id
              AND UPPER(status) IN ('PENDING', 'OPEN', 'TRIGGER_PENDING', 'VALIDATION_PENDING')
              AND (
                info = p_linked_position_id::text 
                OR symbol = p_symbol
                OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(p_symbol)
              );
        END IF;
    END IF;

    RETURN v_order_id;
END;
$$;
