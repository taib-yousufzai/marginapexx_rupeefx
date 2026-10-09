-- ==============================================================================
-- DATABASE v2: Exit Validation Regression Suite
--
-- Tests the specific failure scenarios that caused:
--   "No open position exists to exit."
--
-- ROOT CAUSE (proven in investigation):
--   The original exit validation query in place_order_v2 lacked:
--   (A) AND side <> p_side   — GROUP BY side with SELECT INTO (no STRICT) could
--       silently pick the same-side row when both BUY and SELL positions existed,
--       returning qty_open=0 for the same-side closed rows and firing the guard.
--   (B) AND product_type = p_product_type — exit for INTRADAY could see CARRY
--       qty and pass validation, then the FIFO loop (which does filter by
--       product_type) would silently close nothing.
--
-- FIX (applied to place_order_v2.sql):
--   Validation query now uses AND product_type = p_product_type AND side <> p_side
--   FIFO routing loop now uses AND product_type = p_product_type
--
-- Difference from position_engine_validation.sql (regression suite):
--   That suite tests lifecycle correctness.
--   This suite specifically targets the exit guard invariant.
--
-- Run in Supabase SQL editor after deploying the updated place_order_v2.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.rc_assert(p_condition boolean, p_message text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT p_condition THEN
        RAISE EXCEPTION 'REGRESSION VIOLATION: %', p_message;
    END IF;
END;
$$;

DO $$
DECLARE
    v_user        uuid;
    v_order_id    uuid;
    v_pos         RECORD;
    v_open_count  integer;
    v_closed_count integer;
    v_initial_bal numeric := 500000;
BEGIN
    RAISE NOTICE '=================================================================';
    RAISE NOTICE 'EXIT VALIDATION REGRESSION SUITE';
    RAISE NOTICE '=================================================================';

    -- Seed test symbol
    INSERT INTO public.script_settings (symbol, lot_size)
    VALUES ('RC_SYM', 1) ON CONFLICT (symbol) DO NOTHING;

    v_user := gen_random_uuid();
    INSERT INTO auth.users  (id, email) VALUES (v_user, 'rc_exit@marginapex.com');
    INSERT INTO public.profiles (id, active, role, balance, settlement_amount, client_id)
    VALUES (v_user, true, 'user', v_initial_bal, v_initial_bal, 'RC_USR');
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_user, 'DEPOSIT', v_initial_bal, 'APPROVED', 'RC_DEPOSIT');

    -- ==========================================================================
    -- RC-1: Normal BUY → SELL exit (baseline, must succeed)
    -- Verifies the fix does not break the standard exit path.
    -- ==========================================================================
    RAISE NOTICE 'RC-1: Normal BUY position → SELL exit...';

    PERFORM public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 0,
        p_idempotency_key => 'rc1_entry'
    );

    v_order_id := public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'INTRADAY',
        10, 10, 110, 110, true, 0, 'EXECUTED',
        p_expected_margin => 0, p_expected_brokerage => 0,
        p_idempotency_key => 'rc1_exit'
    );

    PERFORM public.rc_assert(v_order_id IS NOT NULL, 'RC-1: exit order_id must not be null');

    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM' AND status IN ('open','active') AND product_type = 'INTRADAY';
    PERFORM public.rc_assert(v_open_count = 0, 'RC-1: position must be fully closed');

    RAISE NOTICE 'RC-1: PASS';

    -- Clean slate for next test
    DELETE FROM public.positions WHERE user_id = v_user;
    DELETE FROM public.orders    WHERE user_id = v_user;
    DELETE FROM public.transactions WHERE user_id = v_user AND type <> 'DEPOSIT';

    -- ==========================================================================
    -- RC-2: Normal SELL position → BUY exit (opposite direction, must succeed)
    -- ==========================================================================
    RAISE NOTICE 'RC-2: Normal SELL position → BUY exit...';

    PERFORM public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'INTRADAY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 0,
        p_idempotency_key => 'rc2_entry'
    );

    v_order_id := public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
        10, 10, 90, 90, true, 0, 'EXECUTED',
        p_expected_margin => 0, p_expected_brokerage => 0,
        p_idempotency_key => 'rc2_exit'
    );

    PERFORM public.rc_assert(v_order_id IS NOT NULL, 'RC-2: exit order_id must not be null');

    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM' AND status IN ('open','active') AND product_type = 'INTRADAY';
    PERFORM public.rc_assert(v_open_count = 0, 'RC-2: SELL position must be fully closed');

    RAISE NOTICE 'RC-2: PASS';

    DELETE FROM public.positions WHERE user_id = v_user;
    DELETE FROM public.orders    WHERE user_id = v_user;
    DELETE FROM public.transactions WHERE user_id = v_user AND type <> 'DEPOSIT';

    -- ==========================================================================
    -- RC-3: BUG A REPRODUCTION — Both BUY and SELL positions exist for same symbol.
    --
    -- Without the fix, GROUP BY side returns 2 rows. SELECT INTO (no STRICT)
    -- silently takes one row. If it picks the same-side row (SELL here), the
    -- guard fires "No open position exists to exit" on the BUY exit.
    --
    -- With the fix, AND side <> p_side ensures only the BUY row is returned.
    -- Exit must succeed and close exactly the BUY position.
    -- ==========================================================================
    RAISE NOTICE 'RC-3: BUG A — both BUY and SELL open, exit BUY (SELL exit order)...';

    -- Create BUY position (product_type=INTRADAY)
    PERFORM public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 0,
        p_idempotency_key => 'rc3_buy_entry'
    );

    -- Manually insert a SELL position (simulates a hedge opened outside normal flow,
    -- or a position created by a previous reversal that was not fully closed).
    -- We insert directly to bypass place_order_v2 entry-side checks and set
    -- up the exact table state that triggered the original bug.
    INSERT INTO public.positions (
        user_id, symbol, side, status, qty_total, qty_open,
        avg_price, entry_price, ltp, settlement, product_type,
        entry_brokerage, exit_brokerage, brokerage, locked_margin, margin_required,
        created_at, updated_at, entry_time
    ) VALUES (
        v_user, 'RC_SYM', 'SELL', 'open', 5, 5,
        105, 105, 105, 'EQ', 'INTRADAY',
        0, 0, 0, 500, 500,
        now() - interval '1 hour', now(), now() - interval '1 hour'
    );

    -- Now exit the BUY position with a SELL order.
    -- p_side = 'SELL' (exit order side), existing position side = 'BUY'.
    -- Without fix: GROUP BY side returns {BUY,10} and {SELL,5} — non-deterministic pick.
    -- With fix:    AND side <> 'SELL' returns only {BUY,10} — deterministic, correct.
    BEGIN
        v_order_id := public.place_order_v2(
            v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'INTRADAY',
            10, 10, 110, 110, true, 0, 'EXECUTED',
            p_expected_margin => 0, p_expected_brokerage => 0,
            p_idempotency_key => 'rc3_buy_exit'
        );
        PERFORM public.rc_assert(v_order_id IS NOT NULL, 'RC-3: exit order_id must not be null');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'RC-3: FAIL — exit rejected on live BUY position with both sides open: %', SQLERRM;
    END;

    -- Verify: the BUY position is now closed, the SELL position is untouched
    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM' AND status IN ('open','active')
      AND side = 'BUY' AND product_type = 'INTRADAY';
    PERFORM public.rc_assert(v_open_count = 0, 'RC-3: BUY position must be closed');

    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM' AND status IN ('open','active')
      AND side = 'SELL' AND product_type = 'INTRADAY';
    PERFORM public.rc_assert(v_open_count = 1, 'RC-3: SELL position must remain open (untouched)');

    RAISE NOTICE 'RC-3: PASS';

    DELETE FROM public.positions WHERE user_id = v_user;
    DELETE FROM public.orders    WHERE user_id = v_user;
    DELETE FROM public.transactions WHERE user_id = v_user AND type <> 'DEPOSIT';

    -- ==========================================================================
    -- RC-4: BUG B REPRODUCTION — product_type mismatch.
    --
    -- User has CARRY position open. Exit order sends INTRADAY.
    -- Without the fix: validation SUM includes CARRY qty_open > 0, passes guard,
    --   FIFO loop (which filters product_type='INTRADAY') finds nothing, silently
    --   exits without closing anything (CARRY position stays open).
    -- With the fix: validation SUM is 0 for INTRADAY, guard fires correctly:
    --   "No open position exists to exit."  — correct rejection.
    -- ==========================================================================
    RAISE NOTICE 'RC-4: BUG B — CARRY position open, INTRADAY exit (must be rejected)...';

    -- Create a CARRY position
    PERFORM public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'BUY', 'MARKET', 'CARRY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 0,
        p_idempotency_key => 'rc4_carry_entry'
    );

    -- Attempt to exit with INTRADAY — should be rejected because no INTRADAY position exists
    BEGIN
        PERFORM public.place_order_v2(
            v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'INTRADAY',
            10, 10, 110, 110, true, 0, 'EXECUTED',
            p_expected_margin => 0, p_expected_brokerage => 0,
            p_idempotency_key => 'rc4_intraday_exit'
        );
        -- If we get here, the fix is missing: wrong product type was silently accepted
        RAISE EXCEPTION 'RC-4: FAIL — INTRADAY exit on CARRY position was accepted (should be rejected)';
    EXCEPTION WHEN OTHERS THEN
        IF SQLERRM ILIKE '%No open position exists to exit%' THEN
            RAISE NOTICE 'RC-4: PASS — correctly rejected INTRADAY exit on CARRY position';
        ELSIF SQLERRM ILIKE '%RC-4: FAIL%' THEN
            RAISE; -- propagate the test failure
        ELSE
            RAISE EXCEPTION 'RC-4: FAIL — unexpected error: %', SQLERRM;
        END IF;
    END;

    -- Verify the CARRY position was NOT touched
    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM'
      AND status IN ('open','active') AND product_type = 'CARRY';
    PERFORM public.rc_assert(v_open_count = 1, 'RC-4: CARRY position must remain open and untouched');

    DELETE FROM public.positions WHERE user_id = v_user;
    DELETE FROM public.orders    WHERE user_id = v_user;
    DELETE FROM public.transactions WHERE user_id = v_user AND type <> 'DEPOSIT';

    -- ==========================================================================
    -- RC-5: CARRY position open, CARRY exit (must succeed — positive case for RC-4)
    -- ==========================================================================
    RAISE NOTICE 'RC-5: CARRY position → CARRY exit (must succeed)...';

    PERFORM public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'BUY', 'MARKET', 'CARRY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 0,
        p_idempotency_key => 'rc5_carry_entry'
    );

    BEGIN
        v_order_id := public.place_order_v2(
            v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'CARRY',
            10, 10, 110, 110, true, 0, 'EXECUTED',
            p_expected_margin => 0, p_expected_brokerage => 0,
            p_idempotency_key => 'rc5_carry_exit'
        );
        PERFORM public.rc_assert(v_order_id IS NOT NULL, 'RC-5: CARRY exit order_id must not be null');
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'RC-5: FAIL — CARRY exit rejected on live CARRY position: %', SQLERRM;
    END;

    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM'
      AND status IN ('open','active') AND product_type = 'CARRY';
    PERFORM public.rc_assert(v_open_count = 0, 'RC-5: CARRY position must be fully closed');

    RAISE NOTICE 'RC-5: PASS';

    DELETE FROM public.positions WHERE user_id = v_user;
    DELETE FROM public.orders    WHERE user_id = v_user;
    DELETE FROM public.transactions WHERE user_id = v_user AND type <> 'DEPOSIT';

    -- ==========================================================================
    -- RC-6: BUG A VARIANT — same-side closed rows exist alongside live position.
    --
    -- This is the most common production trigger: user exits a partial lot,
    -- leaving a closed position row (qty_open=0) for the same side. The next
    -- exit on the same symbol sees both the closed row (qty_open=0) and the
    -- open row (qty_open>0) in the same GROUP BY side bucket.
    --
    -- Without fix: COALESCE(SUM(qty_open),0) could return 0 if the closed row
    -- is in the same side group and the query includes status='closed' — but
    -- the WHERE already filters status IN ('open','active'), so this specific
    -- path only fires if both sides have open rows. However, for the single-side
    -- case, this test confirms the normal path still works after partial exits.
    -- ==========================================================================
    RAISE NOTICE 'RC-6: Partial exit followed by full exit (multi-lot residual)...';

    -- Create 3 lots
    FOR i IN 1..3 LOOP
        PERFORM public.place_order_v2(
            v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
            5, 5, 100, 100, false, 0, 'EXECUTED',
            p_expected_margin => 500, p_expected_brokerage => 0,
            p_idempotency_key => 'rc6_entry_' || i::text
        );
    END LOOP;

    -- Exit 7 (partial — closes lot 1 fully, lot 2 partially)
    PERFORM public.place_order_v2(
        v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'INTRADAY',
        7, 7, 110, 110, true, 0, 'EXECUTED',
        p_expected_margin => 0, p_expected_brokerage => 0,
        p_idempotency_key => 'rc6_partial_exit'
    );

    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM'
      AND status IN ('open','active') AND product_type = 'INTRADAY';
    PERFORM public.rc_assert(v_open_count >= 1, 'RC-6: at least one open lot must remain after partial exit');

    -- Exit remaining 8
    BEGIN
        PERFORM public.place_order_v2(
            v_user, 'RC_SYM', 'RC_SYM', 'EQ', 'SELL', 'MARKET', 'INTRADAY',
            8, 8, 115, 115, true, 0, 'EXECUTED',
            p_expected_margin => 0, p_expected_brokerage => 0,
            p_idempotency_key => 'rc6_full_exit'
        );
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION 'RC-6: FAIL — second exit rejected on live residual position: %', SQLERRM;
    END;

    SELECT count(*) INTO v_open_count
    FROM public.positions
    WHERE user_id = v_user AND symbol = 'RC_SYM'
      AND status IN ('open','active') AND product_type = 'INTRADAY';
    PERFORM public.rc_assert(v_open_count = 0, 'RC-6: all lots must be closed after full exit');

    RAISE NOTICE 'RC-6: PASS';

    -- ==========================================================================
    -- TEARDOWN
    -- ==========================================================================
    DELETE FROM public.transactions WHERE user_id = v_user;
    DELETE FROM public.positions    WHERE user_id = v_user;
    DELETE FROM public.orders       WHERE user_id = v_user;
    DELETE FROM public.profiles     WHERE id = v_user;
    DELETE FROM auth.users          WHERE id = v_user;

    RAISE NOTICE '=================================================================';
    RAISE NOTICE 'EXIT VALIDATION REGRESSION SUITE: ALL PASSED';
    RAISE NOTICE '=================================================================';
END;
$$;

DROP FUNCTION IF EXISTS public.rc_assert(boolean, text);
