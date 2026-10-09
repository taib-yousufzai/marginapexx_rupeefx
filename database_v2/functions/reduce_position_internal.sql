-- ==============================================================================
-- DATABASE v2: reduce_position_internal
-- Internal helper to process a partial exit, calculating realized P&L and 
-- returning released margin. Also inserts a closed position for reporting.
-- ==============================================================================

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
    v_stop_loss numeric;
    v_target numeric;
    v_entry_time timestamptz;
    
    v_pnl numeric;
    v_margin_released numeric;
    v_pnl_type text;
    v_new_closed_id uuid;
BEGIN
    -- STEP 1: Strict Global Lock Hierarchy (profiles -> positions -> transactions)
    SELECT user_id INTO v_user_id FROM public.positions WHERE id = p_position_id;
    IF v_user_id IS NOT NULL THEN
        PERFORM 1 FROM public.profiles WHERE id = v_user_id FOR UPDATE;
    END IF;

    -- STEP 2: Lock Position
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

    -- Calculate realized P&L
    -- MCX GOLD & GOLDM prices are quoted per 10 grams in INR.
    -- 1 unit of qty = 1 gram. Value multiplier per 1 Re change in quoted price = 0.1
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

    -- Calculate proportional margin release
    v_margin_released := round((v_locked_margin * p_qty) / v_qty_open, 2);

    -- Reduce original position
    UPDATE public.positions
    SET qty_open = qty_open - p_qty,
        qty_total = GREATEST(qty_total - p_qty, qty_open - p_qty),
        locked_margin = locked_margin - v_margin_released,
        margin_required = margin_required - v_margin_released,
        updated_at = now()
    WHERE id = p_position_id;

    -- Insert closed position representing the exited chunk
    INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open, avg_price, entry_price, exit_price, ltp,
        pnl, settlement, product_type, stop_loss, target,
        entry_time, exit_time, duration_seconds,
        locked_margin, margin_required, brokerage
    ) VALUES (
        v_user_id, v_symbol, v_side, 'closed',
        p_qty, 0, v_avg_price, v_avg_price, p_price, p_ltp,
        v_pnl, v_settlement, v_product_type, v_stop_loss, v_target,
        v_entry_time, now(), EXTRACT(EPOCH FROM (now() - v_entry_time))::integer,
        0, v_margin_released, p_expected_brokerage
    ) RETURNING id INTO v_new_closed_id;

    -- STEP 5: Write to Ledger
    -- Brokerage
    IF p_expected_brokerage > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', COALESCE('CLOSE_BRK_' || p_idempotency_key, 'BRK_RED_' || v_new_closed_id::text));
    END IF;

    -- PnL
    IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', COALESCE('CLOSE_PNL_' || p_idempotency_key, 'PNL_RED_' || v_new_closed_id::text));
    END IF;

    -- Margin Release
    IF v_margin_released > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_user_id, 'MARGIN_CREDIT', v_margin_released, 'APPROVED', COALESCE('CLOSE_MRG_' || p_idempotency_key, 'MRG_RED_' || v_new_closed_id::text));
    END IF;

    RETURN v_pnl;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.reduce_position_internal FROM public;
