-- ==============================================================================
-- DATABASE v2: close_position_v2
-- Atomic, synchronous closure of a position. No triggers required.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.close_position_v2(
  p_position_id        uuid,
  p_close_qty          numeric,
  p_close_price        numeric,
  p_closed_by          text,
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key    text DEFAULT NULL
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
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
    -- ISOLATE V1 TRIGGERS (Strangler Fig)
    PERFORM set_config('app.is_v2', 'true', true);

    -- IDEMPOTENCY CHECK: If this request was already processed, return the cached PNL
    IF p_idempotency_key IS NOT NULL THEN
        SELECT 
          CASE WHEN type = 'PNL_CREDIT' THEN amount ELSE -amount END INTO v_pnl
        FROM public.transactions
        WHERE ref_id = 'CLOSE_PNL_' || p_idempotency_key;
        
        IF FOUND THEN
            RETURN v_pnl;
        END IF;
    END IF;

    -- STEP 1: Lock Position
    SELECT user_id, symbol, side, qty_open, avg_price, locked_margin, margin_required, settlement, product_type
    INTO v_user_id, v_symbol, v_side, v_qty_open, v_avg_price, v_locked_margin, v_margin_required, v_settlement, v_product_type
    FROM public.positions
    WHERE id = p_position_id AND LOWER(status) IN ('open', 'active')
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Position not found or already closed.';
    END IF;

    IF p_close_qty <= 0 THEN
        RAISE EXCEPTION 'Close quantity must be greater than 0.';
    END IF;

    IF p_close_qty > v_qty_open THEN
        RAISE EXCEPTION 'Cannot close more than open quantity (%). Requested: %', v_qty_open, p_close_qty;
    END IF;

    -- STEP 2: Calculate Realized PnL natively in DB to prevent tampering
    -- MCX GOLD & GOLDM prices are quoted per 10 grams in INR.
    -- 1 unit of qty = 1 gram. Value multiplier per 1 Re change in quoted price = 0.1
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

    -- STEP 3: Proportional Margin Release and Lots Calculation
    v_exit_side := CASE WHEN v_side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
    -- If fully closing, release 100% of remaining locked margin to avoid rounding issues
    IF p_close_qty = v_qty_open THEN
        v_margin_released := v_locked_margin;
    ELSE
        v_margin_released := round((v_locked_margin * p_close_qty) / v_qty_open, 2);
    END IF;

    -- STEP 4: Update Position
    UPDATE public.positions
    SET qty_open = qty_open - p_close_qty,
        pnl = pnl + v_pnl,
        brokerage = brokerage + p_expected_brokerage,
        exit_price = p_close_price,
        locked_margin = locked_margin - v_margin_released,
        margin_required = CASE WHEN (qty_open - p_close_qty) <= 0 THEN margin_required ELSE margin_required - v_margin_released END,
        status = CASE WHEN (qty_open - p_close_qty) <= 0 THEN 'closed' ELSE status END,
        closed_by = p_closed_by,
        exit_time = CASE WHEN (qty_open - p_close_qty) <= 0 THEN now() ELSE exit_time END,
        duration_seconds = CASE WHEN (qty_open - p_close_qty) <= 0 THEN EXTRACT(EPOCH FROM (now() - entry_time))::integer ELSE duration_seconds END,
        updated_at = now()
    WHERE id = p_position_id;

    -- Cancel all open/pending orders linked to this position or symbol upon full closure
    IF (v_qty_open - p_close_qty) <= 0 THEN
        UPDATE public.orders
        SET status = 'CANCELLED', updated_at = now()
        WHERE user_id = v_user_id
          AND UPPER(status) IN ('PENDING', 'OPEN', 'TRIGGER_PENDING', 'VALIDATION_PENDING')
          AND (info = p_position_id::text OR linked_position_id = p_position_id OR symbol = v_symbol);
    END IF;

    -- Determine lot size to calculate lots
    SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_symbol LIKE '%' || symbol || '%' ORDER BY length(symbol) DESC LIMIT 1;
    IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
      IF v_symbol LIKE '%BANKNIFTY%' OR v_symbol LIKE '%BANKEX%' THEN v_lot_size := 30;
      ELSIF v_symbol LIKE '%FINNIFTY%' THEN v_lot_size := 60;
      ELSIF v_symbol LIKE '%MIDCPNIFTY%' OR v_symbol LIKE '%MIDCP%' OR v_symbol LIKE '%MIDCAP%' THEN v_lot_size := 120;
      ELSIF v_symbol LIKE '%SENSEX%' THEN v_lot_size := 20;
      ELSIF v_symbol LIKE '%NIFTY%' THEN v_lot_size := 65;
      ELSIF v_symbol LIKE '%GOLDM%' THEN v_lot_size := 10;
      ELSIF v_symbol LIKE '%GOLD%' THEN v_lot_size := 100;
      ELSIF v_symbol LIKE '%SILVERM%' THEN v_lot_size := 5;
      ELSIF v_symbol LIKE '%SILVER%' THEN v_lot_size := 30;
      ELSIF v_symbol LIKE '%CRUDEOILM%' THEN v_lot_size := 10;
      ELSIF v_symbol LIKE '%CRUDEOIL%' THEN v_lot_size := 100;
      ELSIF v_symbol LIKE '%NATGASMINI%' THEN v_lot_size := 250;
      ELSIF v_symbol LIKE '%NATURALGAS%' THEN v_lot_size := 1250;
      ELSE v_lot_size := 1;
      END IF;
    END IF;
    
    v_lots := p_close_qty / v_lot_size;

    -- STEP 5: Record the Exit Order Transaction
    v_order_exists := false;
    IF p_idempotency_key IS NOT NULL THEN
        IF position('_' in p_idempotency_key) > 0 THEN
            SELECT EXISTS (
                SELECT 1 FROM public.orders 
                WHERE user_id = v_user_id AND idempotency_key = split_part(p_idempotency_key, '_', 1)
            ) INTO v_order_exists;
        ELSE
            SELECT EXISTS (
                SELECT 1 FROM public.orders 
                WHERE user_id = v_user_id AND idempotency_key = p_idempotency_key
            ) INTO v_order_exists;
        END IF;
    END IF;

    IF NOT v_order_exists THEN
        INSERT INTO public.orders (
            user_id, symbol, kite_instrument, segment, side, status, qty, lots,
            price, fill_price, ltp_at_entry, order_type, product_type, info, is_exit, idempotency_key
        )
        VALUES (
            v_user_id, v_symbol, v_symbol, COALESCE(v_settlement, 'STOCKS'), v_exit_side, 'EXECUTED', p_close_qty, v_lots,
            p_close_price, p_close_price, p_close_price, 'MARKET', COALESCE(v_product_type, 'INTRADAY'), p_position_id::text, true, p_idempotency_key
        );
    END IF;

    -- STEP 6: Write to Ledger
    -- Brokerage
    IF p_expected_brokerage > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', COALESCE('CLOSE_BRK_' || p_idempotency_key, 'BRK_' || p_position_id::text));
    END IF;

    -- PnL
    IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', COALESCE('CLOSE_PNL_' || p_idempotency_key, 'PNL_' || p_position_id::text));
    END IF;

    -- Margin Release
    IF v_margin_released > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'MARGIN_CREDIT', v_margin_released, 'APPROVED', COALESCE('CLOSE_MRG_' || p_idempotency_key, 'MRG_RET_' || p_position_id::text));
    END IF;

    RETURN v_pnl;
END;
$$;
