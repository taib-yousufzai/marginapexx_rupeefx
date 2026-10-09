-- ==============================================================================
-- DATABASE v2: create_position_internal & Anti-Hedging Constraint Trigger
-- Invariant: NEVER allow simultaneous BUY and SELL positions for the same user & symbol.
-- ==============================================================================

DROP FUNCTION IF EXISTS public.create_position_internal(uuid, text, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, numeric, numeric);
DROP FUNCTION IF EXISTS public.create_position_internal(uuid, text, text, numeric, numeric, numeric, text, text, numeric, numeric, numeric, numeric, numeric);

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
SECURITY DEFINER
AS $$
DECLARE
    v_position_id uuid;
    v_opposite_count int;
BEGIN
    -- Strict invariant check: Verify no active opposite-side positions exist for this user & symbol
    SELECT COUNT(*) INTO v_opposite_count
    FROM public.positions
    WHERE user_id = p_user_id
      AND (
        symbol = p_symbol 
        OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(p_symbol)
      )
      AND LOWER(status) IN ('open', 'active')
      AND qty_open > 0
      AND side <> p_side;

    IF v_opposite_count > 0 THEN
        RAISE EXCEPTION 'Simultaneous BUY and SELL positions are strictly forbidden for symbol %. Netting or exit must occur first.', p_symbol;
    END IF;

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

REVOKE EXECUTE ON FUNCTION public.create_position_internal FROM public;

-- ==============================================================================
-- Trigger Function: trg_fn_prevent_opposite_positions
-- Absolute database-level gatekeeper preventing concurrent BUY and SELL positions
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.trg_fn_prevent_opposite_positions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_has_opposite boolean;
BEGIN
    -- Only check active/open positions with remaining quantity
    IF LOWER(NEW.status) IN ('open', 'active') AND NEW.qty_open > 0 THEN
        SELECT EXISTS (
            SELECT 1 
            FROM public.positions
            WHERE user_id = NEW.user_id
              AND id <> COALESCE(NEW.id, '00000000-0000-0000-0000-000000000000'::uuid)
              AND LOWER(status) IN ('open', 'active')
              AND qty_open > 0
              AND side <> NEW.side
              AND (
                symbol = NEW.symbol 
                OR public.clean_symbol_v2(symbol) = public.clean_symbol_v2(NEW.symbol)
              )
        ) INTO v_has_opposite;

        IF v_has_opposite THEN
            RAISE EXCEPTION 'Database invariant violation: Concurrent BUY and SELL positions are strictly disallowed for symbol %.', NEW.symbol;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_prevent_opposite_positions ON public.positions;
CREATE TRIGGER trg_prevent_opposite_positions
BEFORE INSERT OR UPDATE ON public.positions
FOR EACH ROW
EXECUTE FUNCTION public.trg_fn_prevent_opposite_positions();
