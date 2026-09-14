-- ==============================================================================
-- DATABASE v2: place_order_v2
-- Synchronous Financial Transaction Block routing into the Position Engine.
-- Uses FIFO (First-In, First-Out) lot selection for cumulative exits.
-- ==============================================================================

-- Drop all existing versions to avoid overloaded function ambiguity
DO $$ 
DECLARE 
  r record;
BEGIN
  FOR r IN 
    SELECT oid::regprocedure AS proc
    FROM pg_proc 
    WHERE proname = 'place_order_v2' AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  LOOP
    EXECUTE 'DROP FUNCTION ' || r.proc || ' CASCADE';
  END LOOP;
END $$;

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
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_info           text DEFAULT NULL,
  p_expected_margin numeric DEFAULT 0,
  p_expected_brokerage numeric DEFAULT 0,
  p_idempotency_key text DEFAULT NULL,
  p_linked_position_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
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
    -- ISOLATE V1 TRIGGERS (Strangler Fig)
    PERFORM set_config('app.is_v2', 'true', true);

    -- IDEMPOTENCY CHECK: If this exact request was already processed, return the existing order (Scoped to user)
    IF p_idempotency_key IS NOT NULL THEN
        SELECT id INTO v_order_id 
        FROM public.orders 
        WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key
        LIMIT 1;
        IF FOUND THEN
            RETURN v_order_id;
        END IF;
    END IF;

    -- STEP 1: VALIDATE MARGIN (Calculate vs Validate Rule)
    SELECT balance INTO v_profile_balance
    FROM public.profiles
    WHERE id = p_user_id;

    IF v_profile_balance < (p_expected_margin + p_expected_brokerage + p_buffer_fee) AND p_is_exit = false THEN
        RAISE EXCEPTION 'Insufficient balance. Available: %, Required: %', v_profile_balance, (p_expected_margin + p_expected_brokerage + p_buffer_fee);
    END IF;

    -- STEP 2: INSERT ORDER (Gracefully handle concurrent idempotency race conditions)
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

    -- Set self-referential idempotency key so close_position_v2 can detect this order
    -- and skip creating a duplicate exit order (it checks WHERE idempotency_key = v_order_id::text)
    IF p_idempotency_key IS NULL THEN
        UPDATE public.orders SET idempotency_key = v_order_id::text WHERE id = v_order_id;
    END IF;

    -- STEP 3: ROUTE INTO POSITION ENGINE (Only if immediate execution)
    IF p_status = 'EXECUTED' THEN
        -- Validate exit order constraints
        IF p_is_exit THEN
            -- Check if linked_position_id is supplied to anchor position side & product_type
            IF p_linked_position_id IS NOT NULL THEN
                SELECT side, product_type
                INTO v_pos_side, p_product_type
                FROM public.positions
                WHERE id = p_linked_position_id AND LOWER(status) IN ('open', 'active');
            END IF;

            -- Always calculate total open position quantity across all lots for this symbol & opposite side
            SELECT side, COALESCE(SUM(qty_open), 0)
            INTO v_pos_side, v_pos_qty_open
            FROM public.positions
            WHERE user_id = p_user_id 
              AND (symbol = p_symbol OR symbol ILIKE p_symbol OR symbol ILIKE split_part(p_symbol, ':', 2))
              AND LOWER(status) IN ('open', 'active')
              AND product_type = p_product_type
              AND side <> p_side
            GROUP BY side
            LIMIT 1;

            -- Fall back to any open position for this symbol with opposite side if product_type differed
            IF v_pos_qty_open IS NULL OR v_pos_qty_open <= 0 THEN
                SELECT side, COALESCE(SUM(qty_open), 0), product_type
                INTO v_pos_side, v_pos_qty_open, p_product_type
                FROM public.positions
                WHERE user_id = p_user_id 
                  AND (symbol = p_symbol OR symbol ILIKE p_symbol OR symbol ILIKE split_part(p_symbol, ':', 2))
                  AND LOWER(status) IN ('open', 'active')
                  AND side <> p_side
                GROUP BY side, product_type
                LIMIT 1;
            END IF;

            IF v_pos_qty_open IS NULL OR v_pos_qty_open <= 0 THEN
                RAISE EXCEPTION 'No open position exists to exit.';
            END IF;

            IF v_pos_side = p_side THEN
                RAISE EXCEPTION 'Exit order side (%) must be opposite of open position side (%).', p_side, v_pos_side;
            END IF;

            IF p_qty > v_pos_qty_open THEN
                RAISE EXCEPTION 'Exit quantity (%) exceeds total open position quantity (%).', p_qty, v_pos_qty_open;
            END IF;
        END IF;

        -- Find if an open position exists for this symbol (re-fetch single lot for routing)
        SELECT id, qty_open, side
        INTO v_position_id, v_pos_qty_open, v_pos_side
        FROM public.positions
        WHERE user_id = p_user_id 
          AND (symbol = p_symbol OR symbol ILIKE p_symbol OR symbol ILIKE split_part(p_symbol, ':', 2))
          AND LOWER(status) IN ('open', 'active')
          AND product_type = p_product_type
        ORDER BY entry_time DESC
        LIMIT 1
        FOR UPDATE;

        IF NOT FOUND OR v_pos_side = p_side THEN
            -- Lifecycle: Create Position Lot (Same-side additions create separate lots for FIFO)
            v_position_id := public.create_position_internal(
                p_user_id, p_symbol, p_side, p_qty, p_fill_price, p_ltp,
                p_product_type, p_segment, p_stop_loss, p_target,
                p_expected_margin, p_expected_margin, p_expected_brokerage
            );
            UPDATE public.orders SET info = v_position_id::text WHERE id = v_order_id;

            -- Ledger entries for new position margin
            IF p_expected_margin > 0 THEN
                INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
                VALUES (p_user_id, 'MARGIN_DEBIT', p_expected_margin, 'APPROVED', 'MRG_' || v_order_id::text);
            END IF;

        ELSE
            -- Lifecycle: Opposite-Side Netting/Exiting
            v_remaining_qty := p_qty;
            
            IF p_linked_position_id IS NOT NULL THEN
                -- Target specific lot
                FOR v_pos IN 
                    SELECT id, qty_open 
                    FROM public.positions
                    WHERE id = p_linked_position_id AND LOWER(status) IN ('open', 'active') AND side = v_pos_side
                    FOR UPDATE
                LOOP
                    IF v_remaining_qty <= 0 THEN
                        EXIT;
                    END IF;
                    
                    IF v_pos.qty_open > v_remaining_qty THEN
                        -- Lifecycle: Reduce Position (Partial Close lot)
                        v_closed_qty := v_remaining_qty;
                        PERFORM public.reduce_position_internal(
                            v_pos.id, v_closed_qty, p_fill_price, p_ltp,
                            round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            COALESCE(p_idempotency_key, v_order_id::text) || '_' || v_pos.id::text -- unique per lot
                        );
                        v_remaining_qty := 0;
                    ELSE
                        -- Lifecycle: Close Position (Full Close lot)
                        v_closed_qty := v_pos.qty_open;
                        PERFORM public.close_position_v2(
                            v_pos.id, v_closed_qty, p_fill_price,
                            'FIFO_EXIT', round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            v_order_id::text  -- reuse the already-inserted order id so close_position_v2 skips its own insert
                        );
                        v_remaining_qty := v_remaining_qty - v_closed_qty;
                    END IF;
                END LOOP;
            END IF;

            -- Default FIFO Order Consuming Oldest First (used for unlinked exits or fallback)
            -- Secondary sort: qty_open ASC ensures smallest lots are consumed first when entry_time is identical
            IF v_remaining_qty > 0 THEN
                FOR v_pos IN 
                    SELECT id, qty_open 
                    FROM public.positions
                    WHERE user_id = p_user_id 
                      AND (symbol = p_symbol OR symbol ILIKE p_symbol OR symbol ILIKE split_part(p_symbol, ':', 2))
                      AND LOWER(status) IN ('open', 'active')
                      AND side = v_pos_side AND product_type = p_product_type
                      AND (p_linked_position_id IS NULL OR id != p_linked_position_id)
                    ORDER BY entry_time ASC, qty_open ASC, id ASC
                    FOR UPDATE
                LOOP
                    IF v_remaining_qty <= 0 THEN
                        EXIT;
                    END IF;
    
                    IF v_pos.qty_open > v_remaining_qty THEN
                        -- Lifecycle: Reduce Position (Partial Close lot)
                        v_closed_qty := v_remaining_qty;
                        PERFORM public.reduce_position_internal(
                            v_pos.id, v_closed_qty, p_fill_price, p_ltp,
                            round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            COALESCE(p_idempotency_key, v_order_id::text) || '_' || v_pos.id::text -- unique per lot
                        );
                        v_remaining_qty := 0;
                    ELSE
                        -- Lifecycle: Close Position (Full Close lot)
                        v_closed_qty := v_pos.qty_open;
                        PERFORM public.close_position_v2(
                            v_pos.id, v_closed_qty, p_fill_price,
                            'FIFO_EXIT', round((p_expected_brokerage * v_closed_qty) / p_qty, 2),
                            COALESCE(p_idempotency_key, v_order_id::text) || '_' || v_pos.id::text
                        );
                        v_remaining_qty := v_remaining_qty - v_closed_qty;
                    END IF;
                END LOOP;
            END IF;


            -- Lifecycle: Reverse Position (Create new opposite side position if remaining quantity exists)
            IF v_remaining_qty > 0 THEN
                v_position_id := public.create_position_internal(
                    p_user_id, p_symbol, p_side, v_remaining_qty, p_fill_price, p_ltp,
                    p_product_type, p_segment, p_stop_loss, p_target,
                    p_expected_margin, p_expected_margin, p_expected_brokerage
                );
                UPDATE public.orders SET info = v_position_id::text WHERE id = v_order_id;

                -- Ledger entries for reversed side entry margin debit
                IF p_expected_margin > 0 THEN
                    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
                    VALUES (p_user_id, 'MARGIN_DEBIT', p_expected_margin, 'APPROVED', 'MRG_' || v_order_id::text);
                END IF;
            END IF;
        END IF;

        -- Write brokerage transaction once at order execution level
        IF p_expected_brokerage > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BROKERAGE_DEBIT', p_expected_brokerage, 'APPROVED', 'BRK_' || v_order_id::text);
        END IF;

        -- Write buffer fee transaction once at order execution level
        IF p_buffer_fee > 0 THEN
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (p_user_id, 'BUFFER_FEE_DEBIT', p_buffer_fee, 'APPROVED', 'BUF_' || v_order_id::text);
        END IF;
    END IF;

    RETURN v_order_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.place_order_v2 FROM public;

-- Composite indexes to optimize order idempotency and positions lookups inside place_order_v2
CREATE INDEX IF NOT EXISTS idx_orders_user_idempotency ON public.orders(user_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_positions_user_symbol_status ON public.positions(user_id, symbol, status);
CREATE INDEX IF NOT EXISTS idx_positions_user_symbol_status_side ON public.positions(user_id, symbol, status, side);
