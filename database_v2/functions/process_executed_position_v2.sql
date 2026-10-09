-- ==============================================================================
-- DATABASE v2: process_executed_position (Bridge for Order Matching Engine)
-- Bridges background order executions into Database v2 Position Engine
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.process_executed_position(
  p_order_id uuid,
  p_info     text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order record;
  v_pos record;
  v_matched_pos_id uuid := NULL;
  v_matched_pos_side text := NULL;
  v_pos_qty_open numeric := 0;
  v_position_id uuid;
  v_closed_qty numeric;
  v_remaining_qty numeric;
  v_linked_pos_id uuid;
BEGIN
  -- Fetch order details
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE WARNING 'process_executed_position: Order % not found', p_order_id;
    RETURN;
  END IF;

  -- Try resolving linked position UUID from argument, column, or info string
  IF p_info IS NOT NULL AND p_info ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_linked_pos_id := p_info::uuid;
  ELSIF v_order.linked_position_id IS NOT NULL THEN
    v_linked_pos_id := v_order.linked_position_id;
  ELSIF v_order.info IS NOT NULL AND v_order.info ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    v_linked_pos_id := v_order.info::uuid;
  END IF;

  -- Check linked position directly if present
  IF v_linked_pos_id IS NOT NULL THEN
    SELECT id, side, product_type, symbol, qty_open
    INTO v_pos
    FROM public.positions
    WHERE id = v_linked_pos_id AND LOWER(status) IN ('open', 'active')
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      v_matched_pos_id := v_pos.id;
      v_matched_pos_side := v_pos.side;
    END IF;
  END IF;

  -- If not linked directly, find any open opposite position for symbol
  IF v_matched_pos_id IS NULL THEN
    SELECT id, side, product_type, symbol, qty_open
    INTO v_pos
    FROM public.positions
    WHERE user_id = v_order.user_id
      AND (
        symbol = v_order.symbol
        OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(v_order.symbol)
      )
      AND LOWER(status) IN ('open', 'active')
      AND side <> v_order.side
    ORDER BY entry_time ASC, id ASC
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      v_matched_pos_id := v_pos.id;
      v_matched_pos_side := v_pos.side;
    END IF;
  END IF;

  -- Calculate total open opposite position quantity
  SELECT COALESCE(SUM(qty_open), 0)
  INTO v_pos_qty_open
  FROM public.positions
  WHERE user_id = v_order.user_id
    AND (
      symbol = v_order.symbol
      OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(v_order.symbol)
    )
    AND LOWER(status) IN ('open', 'active')
    AND side <> v_order.side;

  v_pos_qty_open := COALESCE(v_pos_qty_open, 0);

  -- 1. EXIT or OPPOSITE-SIDE NETTING
  IF (v_order.is_exit = true OR v_pos_qty_open > 0) AND v_matched_pos_side IS NOT NULL AND v_matched_pos_side <> v_order.side THEN
    v_remaining_qty := v_order.qty;

    -- Close targeted lot first if linked
    IF v_linked_pos_id IS NOT NULL AND v_matched_pos_id = v_linked_pos_id THEN
      IF v_pos.qty_open > v_remaining_qty THEN
        v_closed_qty := v_remaining_qty;
        PERFORM public.reduce_position_internal(
          v_pos.id, v_closed_qty, v_order.fill_price, COALESCE(v_order.ltp_at_entry, v_order.fill_price),
          round((COALESCE(v_order.brokerage, 0) * v_closed_qty) / v_order.qty, 2),
          COALESCE(v_order.idempotency_key, v_order.id::text) || '_' || v_pos.id::text
        );
        v_remaining_qty := 0;
      ELSE
        v_closed_qty := v_pos.qty_open;
        PERFORM public.close_position_v2(
          v_pos.id, v_closed_qty, v_order.fill_price,
          'TRIGGER_EXIT', round((COALESCE(v_order.brokerage, 0) * v_closed_qty) / v_order.qty, 2),
          COALESCE(v_order.idempotency_key, v_order.id::text) || '_' || v_pos.id::text, true
        );
        v_remaining_qty := v_remaining_qty - v_closed_qty;
      END IF;
    END IF;

    -- FIFO cascade for remaining quantity
    IF v_remaining_qty > 0 THEN
      FOR v_pos IN
        SELECT id, qty_open
        FROM public.positions
        WHERE user_id = v_order.user_id
          AND (
            symbol = v_order.symbol
            OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(v_order.symbol)
          )
          AND LOWER(status) IN ('open', 'active')
          AND side = v_matched_pos_side
          AND (v_linked_pos_id IS NULL OR id != v_linked_pos_id)
        ORDER BY entry_time ASC, qty_open ASC, id ASC
        FOR UPDATE
      LOOP
        IF v_remaining_qty <= 0 THEN
          EXIT;
        END IF;

        IF v_pos.qty_open > v_remaining_qty THEN
          v_closed_qty := v_remaining_qty;
          PERFORM public.reduce_position_internal(
            v_pos.id, v_closed_qty, v_order.fill_price, COALESCE(v_order.ltp_at_entry, v_order.fill_price),
            round((COALESCE(v_order.brokerage, 0) * v_closed_qty) / v_order.qty, 2),
            COALESCE(v_order.idempotency_key, v_order.id::text) || '_' || v_pos.id::text
          );
          v_remaining_qty := 0;
        ELSE
          v_closed_qty := v_pos.qty_open;
          PERFORM public.close_position_v2(
            v_pos.id, v_closed_qty, v_order.fill_price,
            'TRIGGER_EXIT', round((COALESCE(v_order.brokerage, 0) * v_closed_qty) / v_order.qty, 2),
            COALESCE(v_order.idempotency_key, v_order.id::text) || '_' || v_pos.id::text, true
          );
          v_remaining_qty := v_remaining_qty - v_closed_qty;
        END IF;
      END LOOP;
    END IF;

    -- If order was not an exit order and remaining quantity flipped side, create position for remainder
    IF (v_order.is_exit IS NOT TRUE) AND v_remaining_qty > 0 THEN
      v_position_id := public.create_position_internal(
        v_order.user_id, v_order.symbol, v_order.side, v_remaining_qty, v_order.fill_price, COALESCE(v_order.ltp_at_entry, v_order.fill_price),
        COALESCE(v_order.product_type, 'INTRADAY'), COALESCE(v_order.segment, 'STOCKS'), v_order.stop_loss, v_order.target,
        0, 0, COALESCE(v_order.brokerage, 0)
      );
      UPDATE public.orders SET info = v_position_id::text WHERE id = v_order.id;
    END IF;

  ELSE
    -- 2. FRESH ENTRY ORDER
    IF (v_order.is_exit IS NOT TRUE) THEN
      v_position_id := public.create_position_internal(
        v_order.user_id, v_order.symbol, v_order.side, v_order.qty, v_order.fill_price, COALESCE(v_order.ltp_at_entry, v_order.fill_price),
        COALESCE(v_order.product_type, 'INTRADAY'), COALESCE(v_order.segment, 'STOCKS'), v_order.stop_loss, v_order.target,
        0, 0, COALESCE(v_order.brokerage, 0)
      );
      UPDATE public.orders SET info = v_position_id::text WHERE id = v_order.id;
    END IF;
  END IF;

END;
$$;

REVOKE EXECUTE ON FUNCTION public.process_executed_position FROM public;
