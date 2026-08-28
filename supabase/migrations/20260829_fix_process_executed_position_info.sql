-- Migration to fix process_executed_position ignoring v_order.info when called from triggers
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid, p_info text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_pos record;
  v_closed_pos_id uuid;
  v_pnl numeric;
  v_pnl_type text;
  v_remaining_qty numeric;
  v_close_qty numeric;
  v_chunk_brokerage numeric;
  v_closed_entry_brokerage numeric;
  v_closed_brokerage numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order not found';
  END IF;

  IF v_order.status <> 'EXECUTED' THEN
    RAISE EXCEPTION 'Order must be EXECUTED to process positioning';
  END IF;

  IF v_order.fill_price IS NULL THEN
    RAISE EXCEPTION 'EXECUTED order must have fill_price set';
  END IF;

  -- 1. Deduct Brokerage and Buffer Fee (Single Source of Truth)
  IF COALESCE(v_order.brokerage, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_order.brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  IF COALESCE(v_order.buffer_fee, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- Defensive Guard
  IF v_order.qty <= 0 THEN
    RAISE EXCEPTION 'Order qty must be > 0 to execute';
  END IF;

  IF v_order.is_exit THEN
    -- 2. EXIT LOGIC
    v_remaining_qty := v_order.qty;

    FOR v_pos IN
      SELECT * 
      FROM public.positions
      WHERE user_id = v_order.user_id 
        AND symbol = v_order.symbol 
        AND status IN ('open', 'active') 
        AND product_type = v_order.product_type
        AND side != v_order.side
        AND (COALESCE(p_info, v_order.info) IS NULL OR id::text = COALESCE(p_info, v_order.info))
      ORDER BY entry_time ASC
      FOR UPDATE
    LOOP
      IF v_remaining_qty <= 0 THEN
        EXIT;
      END IF;

      IF v_pos.qty_open <= 0 THEN
        CONTINUE;
      END IF;

      v_close_qty := LEAST(v_remaining_qty, v_pos.qty_open);
      v_chunk_brokerage := (v_order.brokerage * v_close_qty) / v_order.qty;

      -- Calculate realized P&L
      IF v_pos.side = 'BUY' THEN
        v_pnl := (v_order.fill_price - v_pos.entry_price) * v_close_qty;
      ELSE
        v_pnl := (v_pos.entry_price - v_order.fill_price) * v_close_qty;
      END IF;

      IF v_close_qty = v_pos.qty_open THEN
        -- FULL EXIT
        UPDATE public.positions
        SET
          status = 'closed',
          qty_open = 0,
          exit_price = v_order.fill_price,
          exit_time = now(),
          pnl = v_pnl,
          exit_brokerage = exit_brokerage + v_chunk_brokerage,
          brokerage = brokerage + v_chunk_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;

        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        IF v_pnl <> 0 THEN
          INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
          VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);
        END IF;

      ELSE
        -- PARTIAL EXIT: Split position
        v_closed_entry_brokerage := (v_pos.entry_brokerage * v_close_qty) / v_pos.qty_open;
        v_closed_brokerage := (v_pos.brokerage * v_close_qty) / v_pos.qty_open;

        UPDATE public.positions
        SET
          qty_open = qty_open - v_close_qty,
          qty_total = qty_total - v_close_qty,
          entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
          brokerage = brokerage - v_closed_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;

        INSERT INTO public.positions (
          user_id, symbol, side, status,
          qty_total, qty_open,
          avg_price, entry_price, ltp,
          settlement, product_type, exit_price, exit_time, pnl, 
          entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
        )
        VALUES (
          v_order.user_id, v_order.symbol, v_pos.side, 'closed',
          v_close_qty, 0,
          v_pos.avg_price, v_pos.entry_price, COALESCE(v_order.fill_price, v_order.ltp_at_entry),
          v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
          v_closed_entry_brokerage, v_chunk_brokerage, v_closed_entry_brokerage + v_chunk_brokerage, now(), now()
        )
        RETURNING id INTO v_closed_pos_id;

        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        IF v_pnl <> 0 THEN
          INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
          VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);
        END IF;
      END IF;

      v_remaining_qty := v_remaining_qty - v_close_qty;
    END LOOP;

    IF v_remaining_qty > 0 THEN
       RAISE EXCEPTION 'Exit quantity cannot exceed total open position quantity';
    END IF;

  ELSE
    -- 3. ENTRY LOGIC
    INSERT INTO public.positions (
      user_id, symbol, side, status,
      qty_total, qty_open,
      avg_price, entry_price, ltp,
      settlement, product_type, stop_loss, target, 
      entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
    )
    VALUES (
      v_order.user_id, v_order.symbol, v_order.side, 'open',
      v_order.qty, v_order.qty,
      v_order.fill_price, v_order.fill_price, COALESCE(v_order.fill_price, v_order.ltp_at_entry),
      v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
      v_order.brokerage, 0, v_order.brokerage, now(), now()
    );
  END IF;

END;
$$;
