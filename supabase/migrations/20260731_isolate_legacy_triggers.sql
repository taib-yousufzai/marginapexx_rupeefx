-- ==============================================================================
-- MIGRATION: Isolate Legacy Triggers for v2 Sandbox (Strangler Fig Pattern)
-- Date: 2026-07-31
-- ==============================================================================
-- To allow place_order_v2 to run in parallel without triggering v1 side-effects,
-- we inject a `current_setting('app.is_v2', true)` check into the legacy triggers.
-- If true, the trigger bypasses its business logic.

-- 1. Isolate handle_order_execution (Orders Trigger)
CREATE OR REPLACE FUNCTION public.handle_order_execution()
  RETURNS TRIGGER AS $$
  DECLARE
    v_opt_underlying text;
    v_opt_strike numeric;
    v_opt_type text;
    v_is_option boolean := false;
    
    v_remaining_qty numeric;
    v_pos RECORD;
    v_closed_qty numeric;
    v_pnl numeric;
    v_pnl_type text;
    v_new_closed_id uuid;
    v_closed_margin numeric;
  BEGIN
    -- BYPASS FOR V2 TRANSACTIONS
    IF coalesce(nullif(current_setting('app.is_v2', true), ''), 'false')::boolean IS TRUE THEN
      RETURN NEW;
    END IF;

    -- Only run for status = 'EXECUTED'
    IF NEW.status != 'EXECUTED' THEN
      RETURN NEW;
    END IF;
  
    -- Try parsing option details
    SELECT o_underlying, o_strike, o_option_type 
    INTO v_opt_underlying, v_opt_strike, v_opt_type
    FROM public.parse_option_symbol(NEW.symbol);
  
    IF NOT FOUND THEN
      v_opt_underlying := NULL;
      v_opt_strike := NULL;
      v_opt_type := NULL;
    END IF;

    IF v_opt_underlying IS NOT NULL AND v_opt_strike IS NOT NULL AND v_opt_type IS NOT NULL THEN
      v_is_option := true;
    END IF;
  
    IF v_is_option THEN
      IF NEW.is_exit THEN
        v_remaining_qty := NEW.qty;
        
        -- Loop through open positions on the opposite side, matching by option key!
        FOR v_pos IN 
          SELECT p.*, opt.o_underlying, opt.o_strike, opt.o_option_type
          FROM public.positions p
          CROSS JOIN LATERAL (
            SELECT * FROM public.parse_option_symbol(p.symbol) LIMIT 1
          ) opt
          WHERE p.user_id = NEW.user_id
            AND p.status = 'open'
            AND p.qty_open > 0
            AND p.side = CASE WHEN NEW.side = 'BUY' THEN 'SELL' ELSE 'BUY' END
            AND opt.o_underlying = v_opt_underlying
            AND opt.o_strike = v_opt_strike
            AND opt.o_option_type = v_opt_type
          ORDER BY p.entry_time ASC
          FOR UPDATE
        LOOP
          IF v_remaining_qty <= 0 THEN
            EXIT;
          END IF;
    
          IF v_pos.qty_open > v_remaining_qty THEN
            -- PARTIAL EXIT of this position row
            v_closed_qty := v_remaining_qty;
            v_closed_margin := round((v_pos.locked_margin * v_closed_qty) / v_pos.qty_open, 2);
    
            -- 1. Reduce the original position's qty_open only
            UPDATE public.positions
            SET 
              qty_open = qty_open - v_closed_qty,
              locked_margin = locked_margin - v_closed_margin,
              margin_required = margin_required - v_closed_margin,
              updated_at = now()
            WHERE id = v_pos.id;
    
            -- Calculate realized P&L for this closed part
            IF NEW.fill_price IS NULL THEN
              RAISE EXCEPTION 'fill_price cannot be NULL for executed exit order id %', NEW.id;
            END IF;

            IF v_pos.side = 'BUY' THEN
              v_pnl := (NEW.fill_price - v_pos.entry_price) * v_closed_qty;
            ELSE
              v_pnl := (v_pos.entry_price - NEW.fill_price) * v_closed_qty;
            END IF;
    
            -- 2. Insert a new closed position representing the exited part
            INSERT INTO public.positions (
              user_id, symbol, side, status,
              qty_total, qty_open,
              avg_price, entry_price, exit_price, ltp,
              pnl, settlement, product_type, stop_loss, target,
              entry_time, exit_time, duration_seconds,
              locked_margin, margin_required
            )
            VALUES (
              NEW.user_id, v_pos.symbol, v_pos.side, 'closed',
              v_closed_qty, 0,
              v_pos.entry_price, v_pos.entry_price, NEW.fill_price, COALESCE(NEW.fill_price, NEW.ltp_at_entry),
              v_pnl, v_pos.settlement, v_pos.product_type, v_pos.stop_loss, v_pos.target,
              v_pos.entry_time, now(), EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer,
              0, v_closed_margin
            )
            RETURNING id INTO v_new_closed_id;
    
            -- 3. Insert transaction
            v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (NEW.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_new_closed_id::text);
    
            v_remaining_qty := 0;
          ELSE
            -- FULL EXIT of this position row
            v_closed_qty := v_pos.qty_open;
    
            -- Calculate P&L
            IF NEW.fill_price IS NULL THEN
              RAISE EXCEPTION 'fill_price cannot be NULL for executed exit order id %', NEW.id;
            END IF;

            IF v_pos.side = 'BUY' THEN
              v_pnl := (NEW.fill_price - v_pos.entry_price) * v_closed_qty;
            ELSE
              v_pnl := (v_pos.entry_price - NEW.fill_price) * v_closed_qty;
            END IF;
    
            UPDATE public.positions
            SET 
              qty_open = 0,
              status = 'closed',
              exit_price = NEW.fill_price,
              pnl = v_pnl,
              exit_time = now(),
              duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
              updated_at = now()
            WHERE id = v_pos.id;
    
            v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
            INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
            VALUES (NEW.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);
    
            v_remaining_qty := v_remaining_qty - v_closed_qty;
          END IF;
        END LOOP;
    
        -- If there's still remaining qty, raise an error as over-closing is not allowed for exits
        IF v_remaining_qty > 0 THEN
          RAISE EXCEPTION 'Exit qty % exceeds total open option qty for symbol % user %', NEW.qty, NEW.symbol, NEW.user_id;
        END IF;
      ELSE
        -- Option entry logic fallback
        PERFORM public.process_executed_position(NEW.id);
      END IF;
  
    ELSE
      -- Non-option fallback or standard process_executed_position trigger
      PERFORM public.process_executed_position(NEW.id);
    END IF;
  
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- 2. Isolate calculate_position_margin (Positions Trigger)
CREATE OR REPLACE FUNCTION public.calculate_position_margin()
  RETURNS trigger AS $$
  DECLARE
    v_leverage      numeric;
    v_leverage_type text;
    v_parent_id     uuid;
    v_trading_mode  text;
    v_lot_size      numeric := 1;
    v_lots          numeric;
    v_computed_margin numeric;
    v_settings_table  text;
  BEGIN
    -- BYPASS FOR V2 TRANSACTIONS
    IF coalesce(nullif(current_setting('app.is_v2', true), ''), 'false')::boolean IS TRUE THEN
      RETURN NEW;
    END IF;

    IF NEW.status = 'closed' OR NEW.qty_open = 0 THEN
      IF TG_OP = 'UPDATE' AND OLD.locked_margin > 0 THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (NEW.user_id, 'MARGIN_CREDIT', OLD.locked_margin, 'APPROVED', 'MRG_RET_' || NEW.id::text);
        NEW.locked_margin := 0;
        -- preserve margin_required as historical exposure
      ELSIF TG_OP = 'UPDATE' THEN
        NEW.locked_margin := 0;
        -- preserve margin_required as historical exposure
      ELSE
        -- On INSERT of a closed position (e.g. partial exit split), keep the inserted values
        NEW.margin_required := COALESCE(NEW.margin_required, NEW.locked_margin, 0);
        NEW.locked_margin := COALESCE(NEW.locked_margin, NEW.margin_required, 0);
      END IF;
      RETURN NEW;
    END IF;

    IF NEW.entry_price IS NULL OR NEW.entry_price <= 0 THEN
      RAISE EXCEPTION 'Invalid entry price % for margin calculation', NEW.entry_price;
    END IF;
  
    SELECT COALESCE(lower(trading_mode), 'standard') INTO v_trading_mode 
    FROM public.profiles 
    WHERE id = NEW.user_id;
    IF v_trading_mode = 'scalper' THEN v_settings_table := 'scalper_segment_settings'; ELSE v_settings_table := 'segment_settings'; END IF;
  
    IF v_settings_table = 'scalper_segment_settings' THEN
      SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.scalper_segment_settings WHERE user_id = NEW.user_id AND segment = NEW.settlement AND side = NEW.side LIMIT 1;
    ELSE
      SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.segment_settings WHERE user_id = NEW.user_id AND segment = NEW.settlement AND side = NEW.side LIMIT 1;
    END IF;
  
    IF v_leverage IS NULL THEN
      SELECT parent_id::uuid INTO v_parent_id FROM public.profiles WHERE id = NEW.user_id;
      IF v_parent_id IS NOT NULL THEN
        IF v_settings_table = 'scalper_segment_settings' THEN
          SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.scalper_segment_settings WHERE user_id = v_parent_id AND segment = NEW.settlement AND side = NEW.side LIMIT 1;
        ELSE
          SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.segment_settings WHERE user_id = v_parent_id AND segment = NEW.settlement AND side = NEW.side LIMIT 1;
        END IF;
      END IF;
    END IF;
  
    IF v_leverage IS NULL OR v_leverage <= 0 THEN
      v_leverage_type := 'Multiplier';
      IF NEW.settlement LIKE '%FOREX%' OR NEW.settlement LIKE '%CDS%' THEN v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 10 ELSE 100 END; ELSIF NEW.settlement LIKE '%CRYPTO%' THEN v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 1 ELSE 10 END; ELSE v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 5 ELSE 50 END; END IF;
    END IF;
  
    IF v_leverage IS NULL OR v_leverage <= 0 THEN
      RAISE EXCEPTION 'Invalid leverage settings for product % on segment %', NEW.product_type, NEW.settlement;
    END IF;

    IF v_leverage_type IS NULL OR v_leverage_type = '' THEN v_leverage_type := 'Multiplier'; END IF;
  
    IF v_leverage_type = '%' THEN
      v_computed_margin := (NEW.qty_open * NEW.entry_price) * (v_leverage / 100.0);
    ELSIF v_leverage_type = 'Fixed' THEN
      -- Try to find lot_size from instruments table first (most accurate for active F&O contracts)
      SELECT lot_size INTO v_lot_size
      FROM public.instruments
      WHERE tradingsymbol = NEW.symbol
      LIMIT 1;
      
      IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
        -- Fall back to name-based substring search on instruments
        SELECT i.lot_size INTO v_lot_size
        FROM public.instruments i
        WHERE i.lot_size > 0
          AND (
            NEW.symbol LIKE i.name || '%'
            OR NEW.symbol LIKE '%' || i.name || '%'
          )
        ORDER BY length(i.name) DESC
        LIMIT 1;
      END IF;

      -- If still not found, try script_settings
      IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
        SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE NEW.symbol LIKE '%' || symbol || '%' ORDER BY length(symbol) DESC LIMIT 1;
      END IF;
      
      -- Throw configuration error if still not found
      IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
        RAISE EXCEPTION 'Missing lot_size for symbol % in instruments/script_settings', NEW.symbol;
      END IF;
      v_lots := NEW.qty_open / v_lot_size;
      v_computed_margin := v_lots * v_leverage;
    ELSE
      v_computed_margin := (NEW.qty_open * NEW.entry_price) / v_leverage;
    END IF;
  
    NEW.margin_required := v_computed_margin;
  
    IF TG_OP = 'INSERT' THEN
      NEW.locked_margin := v_computed_margin;
    ELSIF TG_OP = 'UPDATE' THEN
      IF v_computed_margin > OLD.locked_margin THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (NEW.user_id, 'MARGIN_DEBIT', v_computed_margin - OLD.locked_margin, 'APPROVED', 'MRG_ADJ_' || NEW.id::text);
        NEW.locked_margin := v_computed_margin;
      ELSIF v_computed_margin < OLD.locked_margin THEN
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (NEW.user_id, 'MARGIN_CREDIT', OLD.locked_margin - v_computed_margin, 'APPROVED', 'MRG_ADJ_' || NEW.id::text);
        NEW.locked_margin := v_computed_margin;
      END IF;
    END IF;
  
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Isolate position_insert_margin_debit
CREATE OR REPLACE FUNCTION public.position_insert_margin_debit()
  RETURNS TRIGGER AS $$
  BEGIN
    -- BYPASS FOR V2 TRANSACTIONS
    IF coalesce(nullif(current_setting('app.is_v2', true), ''), 'false')::boolean IS TRUE THEN
      RETURN NEW;
    END IF;

    IF NEW.locked_margin > 0 AND NEW.status != 'closed' THEN
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (NEW.user_id, 'MARGIN_DEBIT', NEW.locked_margin, 'APPROVED', 'MRG_' || NEW.id::text);
    END IF;
    RETURN NEW;
  END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Revoke Execution Permissions from PUBLIC for SECURITY DEFINER safety
REVOKE EXECUTE ON FUNCTION public.handle_order_execution() FROM public;
REVOKE EXECUTE ON FUNCTION public.calculate_position_margin() FROM public;
REVOKE EXECUTE ON FUNCTION public.position_insert_margin_debit() FROM public;

