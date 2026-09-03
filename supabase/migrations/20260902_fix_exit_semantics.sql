-- Migration: 20260902_fix_exit_semantics
-- Description: Two defensive guards added to process_executed_position.
--
--   Guard 1 — Secondary exit guard (Bug 1.8 / 1.9 / 1.3):
--     After the is_exit boolean is resolved from the order row, check whether the
--     order_type is SL or SLM AND the info column holds a valid UUID.  If both are
--     true the order is semantically an exit regardless of the stored boolean value
--     (which may be false/null/empty-string due to upstream flag corruption).
--     v_is_exit is forced to TRUE before the exit/entry branch is reached.
--
--   Guard 2 — Entry null-guard (Bug 1.3 / duplicate position creation):
--     Before INSERT INTO positions in the entry branch, check whether an open
--     position with the same user_id, symbol, side, and product_type already
--     exists.  If one does, accumulate into it using a weighted-average entry
--     price rather than inserting a second open position row.
--
-- Preservation:
--   • All exit path logic (full-close, partial-close, PnL, brokerage splits,
--     transactions, audit trail) is completely unchanged.
--   • Brokerage deduction and buffer-fee deduction blocks are unchanged.
--   • Market-entry, favorable-Limit, and GTT pre-entry paths are unchanged —
--     they carry is_exit = false and no UUID in info, so Guard 1 never fires.
--   • The entry path for the first position of a user/symbol/product_type is
--     unchanged; Guard 2 only activates when a duplicate would otherwise be
--     created.
--
-- Idempotency: CREATE OR REPLACE — safe to run multiple times.

CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid, p_info text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order            record;
  v_pos              record;
  v_existing_pos     record;
  v_closed_pos_id    uuid;
  v_pnl              numeric;
  v_pnl_type         text;
  v_remaining_qty    numeric;
  v_close_qty        numeric;
  v_chunk_brokerage  numeric;
  v_closed_entry_brokerage numeric;
  v_closed_brokerage       numeric;
  v_is_exit          boolean;
  v_new_avg_price    numeric;
  v_new_qty_total    numeric;
BEGIN
  -- ── 1. Fetch the order ─────────────────────────────────────────────────────
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

  -- ── 2. Safely resolve is_exit (handles boolean, empty-string, null, text) ──
  BEGIN
    v_is_exit := CASE
      WHEN v_order.is_exit::text IN ('true', 't', '1', 'yes', 'on') THEN true
      ELSE false
    END;
  EXCEPTION WHEN OTHERS THEN
    v_is_exit := false;
  END;

  -- ── 3. Guard 1 — Secondary exit guard ─────────────────────────────────────
  -- If the order_type is SL or SLM AND info contains a valid position UUID,
  -- the order is semantically an exit.  Force v_is_exit = true even when the
  -- stored boolean is false/null (e.g. due to upstream flag corruption on old
  -- rows or a missing is_exit:true in the PATCH payload).
  IF v_order.order_type IN ('SL', 'SLM')
     AND v_order.info IS NOT NULL
     AND v_order.info ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    v_is_exit := true;
  END IF;

  -- ── 4. Deduct Brokerage and Buffer Fee (single source of truth) ───────────
  IF COALESCE(v_order.brokerage, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_order.brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  IF COALESCE(v_order.buffer_fee, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- ── 5. Defensive qty guard ─────────────────────────────────────────────────
  IF v_order.qty <= 0 THEN
    RAISE EXCEPTION 'Order qty must be > 0 to execute';
  END IF;

  -- ── 6. EXIT LOGIC (unchanged from 20260829) ────────────────────────────────
  IF v_is_exit THEN
    v_remaining_qty := v_order.qty;

    FOR v_pos IN
      SELECT *
      FROM public.positions
      WHERE user_id = v_order.user_id
        AND symbol    = v_order.symbol
        AND status    IN ('open', 'active')
        AND product_type = v_order.product_type
        AND side      != v_order.side
        AND (COALESCE(p_info, v_order.info) IS NULL
             OR id::text = COALESCE(p_info, v_order.info))
      ORDER BY entry_time ASC
      FOR UPDATE
    LOOP
      IF v_remaining_qty <= 0 THEN
        EXIT;
      END IF;

      IF v_pos.qty_open <= 0 THEN
        CONTINUE;
      END IF;

      v_close_qty       := LEAST(v_remaining_qty, v_pos.qty_open);
      v_chunk_brokerage := (v_order.brokerage * v_close_qty) / v_order.qty;

      -- Realized P&L
      IF v_pos.side = 'BUY' THEN
        v_pnl := (v_order.fill_price - v_pos.entry_price) * v_close_qty;
      ELSE
        v_pnl := (v_pos.entry_price - v_order.fill_price) * v_close_qty;
      END IF;

      IF v_close_qty = v_pos.qty_open THEN
        -- FULL EXIT
        UPDATE public.positions
        SET
          status        = 'closed',
          qty_open      = 0,
          exit_price    = v_order.fill_price,
          exit_time     = now(),
          pnl           = v_pnl,
          exit_brokerage = exit_brokerage + v_chunk_brokerage,
          brokerage     = brokerage + v_chunk_brokerage,
          updated_at    = now()
        WHERE id = v_pos.id;

        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        IF v_pnl <> 0 THEN
          INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
          VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);
        END IF;

      ELSE
        -- PARTIAL EXIT: split position
        v_closed_entry_brokerage := (v_pos.entry_brokerage * v_close_qty) / v_pos.qty_open;
        v_closed_brokerage       := (v_pos.brokerage       * v_close_qty) / v_pos.qty_open;

        UPDATE public.positions
        SET
          qty_open        = qty_open      - v_close_qty,
          qty_total       = qty_total     - v_close_qty,
          entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
          brokerage       = brokerage     - v_closed_brokerage,
          updated_at      = now()
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
          v_pos.avg_price, v_pos.entry_price,
          COALESCE(v_order.fill_price, v_order.ltp_at_entry),
          v_order.segment, v_pos.product_type,
          v_order.fill_price, now(), v_pnl,
          v_closed_entry_brokerage, v_chunk_brokerage,
          v_closed_entry_brokerage + v_chunk_brokerage,
          now(), now()
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
    -- ── 7. ENTRY LOGIC ─────────────────────────────────────────────────────
    --
    -- Guard 2 — Entry null-guard:
    -- Before inserting a new position, check whether an open position with the
    -- same user_id / symbol / side / product_type already exists.  If one does,
    -- accumulate qty and recalculate weighted-average entry price rather than
    -- creating a duplicate open position row.
    --
    -- This handles the edge case where:
    --   • upstream is_exit flag corruption slipped through Guard 1 (i.e. the
    --     order_type is not SL/SLM, or info is not a UUID), AND
    --   • the position would otherwise be duplicated.
    --
    SELECT * INTO v_existing_pos
    FROM public.positions
    WHERE user_id    = v_order.user_id
      AND symbol     = v_order.symbol
      AND status     = 'open'
      AND side       = v_order.side
      AND product_type = v_order.product_type
    LIMIT 1
    FOR UPDATE;

    IF FOUND THEN
      -- Accumulate into the existing open position using weighted-average pricing.
      v_new_qty_total  := v_existing_pos.qty_total + v_order.qty;
      v_new_avg_price  := (
        (v_existing_pos.entry_price * v_existing_pos.qty_total)
        + (v_order.fill_price       * v_order.qty)
      ) / v_new_qty_total;

      UPDATE public.positions
      SET
        qty_total       = v_new_qty_total,
        qty_open        = qty_open + v_order.qty,
        avg_price       = v_new_avg_price,
        entry_price     = v_new_avg_price,
        entry_brokerage = entry_brokerage + v_order.brokerage,
        brokerage       = brokerage       + v_order.brokerage,
        -- Preserve the most recently set stop_loss / target if the new order
        -- supplies them; otherwise keep the existing values.
        stop_loss       = COALESCE(v_order.stop_loss, v_existing_pos.stop_loss),
        target          = COALESCE(v_order.target,    v_existing_pos.target),
        updated_at      = now()
      WHERE id = v_existing_pos.id;

    ELSE
      -- Normal path: no same-side open position exists; create a new one.
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
        v_order.fill_price, v_order.fill_price,
        COALESCE(v_order.fill_price, v_order.ltp_at_entry),
        v_order.segment, v_order.product_type,
        v_order.stop_loss, v_order.target,
        v_order.brokerage, 0, v_order.brokerage,
        now(), now()
      );
    END IF;

  END IF;

END;
$$;
