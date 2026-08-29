-- ==============================================================================
-- MIGRATION: Fix Settlement Rebaselining & Positive Debt Attribution
-- Date: 2026-08-29
-- Description:
--   1. Ensures settlement_amount is strictly stored as a POSITIVE numeric deficit.
--   2. Updates ref_id pattern matching to support PNL_, CLOSE_PNL_, BRK_, BKG_ prefixes.
--   3. Guarantees profiles.balance is floored at 0 and never goes negative.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rebaseline_user_profile_balance(p_user_id UUID)
RETURNS void AS $$
DECLARE
  r_tx          RECORD;
  v_bal         numeric;
  v_sett        numeric;
  v_change      numeric;
  v_pos_id      UUID;
  v_ref_uuid_str TEXT;
BEGIN
  -- Reset position-level settlement_amount for this user
  UPDATE public.positions
     SET settlement_amount = 0
   WHERE user_id = p_user_id;

  v_bal := 0;
  v_sett := 0;

  FOR r_tx IN 
    SELECT id, type, amount, ref_id
      FROM public.transactions 
     WHERE user_id = p_user_id 
       AND status = 'APPROVED'
       AND type NOT IN ('MARGIN_DEBIT', 'MARGIN_CREDIT')
     ORDER BY created_at ASC, id ASC
  LOOP
    v_change := CASE 
                  WHEN r_tx.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT') 
                  THEN r_tx.amount
                  ELSE -r_tx.amount
                END;
    v_bal := v_bal + v_change;

    IF v_bal < 0 THEN
      -- The shortfall is ABS(v_bal) (a POSITIVE number representing debt).
      v_pos_id := NULL;

      IF r_tx.ref_id IS NOT NULL THEN
        -- Extract any embedded UUID pattern from ref_id (e.g., PNL_<uuid>, CLOSE_PNL_<uuid>, BRK_<uuid>, BKG_EXIT_<uuid>)
        v_ref_uuid_str := substring(r_tx.ref_id from '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');

        IF v_ref_uuid_str IS NOT NULL THEN
          SELECT id INTO v_pos_id
            FROM public.positions
           WHERE id = v_ref_uuid_str::UUID;

          -- Fallback: check trade/order mapping if ref_id pointed to order/trade
          IF v_pos_id IS NULL THEN
            SELECT position_id INTO v_pos_id
              FROM public.trades
             WHERE id = (SELECT trade_id FROM public.executions WHERE order_id = v_ref_uuid_str::UUID LIMIT 1);
          END IF;
        END IF;
      END IF;

      -- If position found, attribute shortfall to position settlement_amount
      IF v_pos_id IS NOT NULL THEN
        UPDATE public.positions
           SET settlement_amount = COALESCE(settlement_amount, 0) + ABS(v_bal)
         WHERE id = v_pos_id;
      END IF;

      -- Accumulate positive debt into v_sett and floor balance at 0
      v_sett := v_sett + ABS(v_bal);
      v_bal := 0;
    END IF;
  END LOOP;

  UPDATE public.profiles
     SET balance = v_bal,
         settlement_amount = v_sett,
         updated_at = now()
   WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Redefine trigger sync_profile_balance
CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN
      RETURN NEW;
    END IF;
    v_user_id := NEW.user_id;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN
      RETURN OLD;
    END IF;
    v_user_id := OLD.user_id;
  END IF;

  IF v_user_id IS NOT NULL THEN
    PERFORM public.rebaseline_user_profile_balance(v_user_id);
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
