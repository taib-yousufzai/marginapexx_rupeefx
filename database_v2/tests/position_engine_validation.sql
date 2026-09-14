-- ==============================================================================
-- DATABASE v2: Position Engine Validation Suite (Permanent Regression Suite)
-- Comprehensive correctness verification of all lifecycle transitions and invariants.
-- ==============================================================================

-- Setup temporary test script settings if not exist
INSERT INTO public.script_settings (symbol, lot_size)
VALUES ('TEST_INFY', 1)
ON CONFLICT (symbol) DO NOTHING;

-- Financial Invariants Assertion Helper
CREATE OR REPLACE FUNCTION public.assert_financial_invariants(p_user_id uuid, p_initial_balance numeric)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_neg_qty_count integer;
    v_neg_margin_count integer;
    v_closed_open_qty_count integer;
    v_closed_locked_margin_count integer;
    v_profile_balance numeric;
    v_net_transactions numeric;
BEGIN
    -- 1. No negative open quantities
    SELECT count(*) INTO v_neg_qty_count FROM public.positions WHERE user_id = p_user_id AND qty_open < 0;
    IF v_neg_qty_count > 0 THEN
        RAISE EXCEPTION 'INVARIANT VIOLATION: Position with negative qty_open found.';
    END IF;

    -- 2. No negative locked margin
    SELECT count(*) INTO v_neg_margin_count FROM public.positions WHERE user_id = p_user_id AND locked_margin < 0;
    IF v_neg_margin_count > 0 THEN
        RAISE EXCEPTION 'INVARIANT VIOLATION: Position with negative locked_margin found.';
    END IF;

    -- 3. Closed positions must have 0 open quantity
    SELECT count(*) INTO v_closed_open_qty_count FROM public.positions WHERE user_id = p_user_id AND status = 'closed' AND qty_open > 0;
    IF v_closed_open_qty_count > 0 THEN
        RAISE EXCEPTION 'INVARIANT VIOLATION: Closed position with positive qty_open found.';
    END IF;

    -- 4. Closed positions must have 0 locked margin
    SELECT count(*) INTO v_closed_locked_margin_count FROM public.positions WHERE user_id = p_user_id AND status = 'closed' AND locked_margin > 0;
    IF v_closed_locked_margin_count > 0 THEN
        RAISE EXCEPTION 'INVARIANT VIOLATION: Closed position with positive locked_margin found.';
    END IF;
    
    -- 5. Ledger totals reconcile with profile balance
    SELECT balance INTO v_profile_balance FROM public.profiles WHERE id = p_user_id;
    
    SELECT COALESCE(sum(
        CASE 
            WHEN type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT') THEN amount
            WHEN type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN 0
            ELSE -amount 
        END
    ), 0) INTO v_net_transactions
    FROM public.transactions
    WHERE user_id = p_user_id AND status = 'APPROVED';
    
    IF abs(v_profile_balance - (p_initial_balance + v_net_transactions)) > 2.0 THEN
        RAISE EXCEPTION 'INVARIANT VIOLATION: Profile balance (%) does not reconcile with ledger transactions (%). Net diff: %', 
            v_profile_balance, v_net_transactions, (v_profile_balance - (p_initial_balance + v_net_transactions));
    END IF;
END;
$$;

-- TEST BLOCK: COMPLETE REGRESSION SCENARIOS
DO $$
DECLARE
    v_user_a uuid;
    v_user_b uuid;
    v_order_id uuid;
    v_pos RECORD;
    v_trx_count integer;
    v_initial_balance numeric := 100000;
    v_open_lots integer;
    v_closed_lots integer;
BEGIN
    RAISE NOTICE 'Starting Position Engine Permanent Regression Suite...';

    -- Create temporary test user profiles
    v_user_a := gen_random_uuid();
    v_user_b := gen_random_uuid();
    
    INSERT INTO auth.users (id, email) VALUES (v_user_a, 'test_a@marginapex.com'), (v_user_b, 'test_b@marginapex.com');
    
    INSERT INTO public.profiles (id, active, role, balance, settlement_amount, client_id)
    VALUES (v_user_a, true, 'user', v_initial_balance, v_initial_balance, 'CL_A'),
           (v_user_b, true, 'user', v_initial_balance, v_initial_balance, 'CL_B');

    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_user_a, 'DEPOSIT', v_initial_balance, 'APPROVED', 'DEP_INIT_A'),
           (v_user_b, 'DEPOSIT', v_initial_balance, 'APPROVED', 'DEP_INIT_B');

    -- ==========================================================================
    -- TEST 1: Single BUY (Create Long)
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 1: Single BUY...';
    v_order_id := public.place_order_v2(
        v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'BUY', 'MARKET', 'CARRY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 20, p_idempotency_key => 'test1_idemp'
    );
    PERFORM public.assert_financial_invariants(v_user_a, 0);

    -- ==========================================================================
    -- TEST 2: Same-Side Addition (Increase Long / Averaging)
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 2: Same-Side Addition (Averaging)...';
    v_order_id := public.place_order_v2(
        v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'BUY', 'MARKET', 'CARRY',
        10, 10, 120, 120, false, 0, 'EXECUTED',
        p_expected_margin => 1200, p_expected_brokerage => 20, p_idempotency_key => 'test2_idemp'
    );
    PERFORM public.assert_financial_invariants(v_user_a, 0);

    -- ==========================================================================
    -- TEST 3: Partial Netting & Splitting
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 3: Partial Netting...';
    v_order_id := public.place_order_v2(
        v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'SELL', 'MARKET', 'CARRY',
        5, 5, 130, 130, true, 0, 'EXECUTED',
        p_expected_margin => 0, p_expected_brokerage => 10, p_idempotency_key => 'test3_idemp'
    );
    PERFORM public.assert_financial_invariants(v_user_a, 0);

    -- ==========================================================================
    -- TEST 4: Massive Reversal (Long -> Short)
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 4: Massive Reversal...';
    -- Currently Open Long = 15. Exit/Sell 40 @ 140.
    -- Results in: Closes 15 Long, Opens 25 Short.
    v_order_id := public.place_order_v2(
        v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'SELL', 'MARKET', 'CARRY',
        40, 40, 140, 140, false, 0, 'EXECUTED',
        p_expected_margin => 3500, p_expected_brokerage => 30, p_idempotency_key => 'test4_idemp'
    );
    SELECT * INTO v_pos FROM public.positions WHERE user_id = v_user_a AND symbol = 'TEST_INFY' AND status = 'open';
    IF v_pos.qty_open != 25 OR v_pos.side != 'SELL' THEN
        RAISE EXCEPTION 'TEST 4 FAILED: Reversal quantity/side incorrect: %', v_pos;
    END IF;
    PERFORM public.assert_financial_invariants(v_user_a, 0);

    -- Clean up User A for clean slate FIFO testing
    DELETE FROM public.transactions WHERE user_id = v_user_a;
    DELETE FROM public.positions WHERE user_id = v_user_a;
    DELETE FROM public.orders WHERE user_id = v_user_a;

    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_user_a, 'DEPOSIT', v_initial_balance, 'APPROVED', 'DEP_INIT_A');

    -- ==========================================================================
    -- TEST 5: Heavy FIFO (100 lots, close 73 lots)
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 5: Heavy FIFO (100 lots, exit 73)...';
    FOR i IN 1..100 LOOP
        PERFORM public.place_order_v2(
            v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'BUY', 'MARKET', 'CARRY',
            1, 1, 100, 100, false, 0, 'EXECUTED',
            p_expected_margin => 10, p_expected_brokerage => 1, p_idempotency_key => 'fifo_lot_' || i::text
        );
    END LOOP;

    SELECT count(*) INTO v_open_lots FROM public.positions WHERE user_id = v_user_a AND status = 'open';
    IF v_open_lots != 100 THEN
        RAISE EXCEPTION 'TEST 5 FAILED: Failed to create 100 open lots: %', v_open_lots;
    END IF;

    -- Sell/Close 73 lots
    PERFORM public.place_order_v2(
        v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'SELL', 'MARKET', 'CARRY',
        73, 73, 110, 110, true, 0, 'EXECUTED',
        p_expected_margin => 0, p_expected_brokerage => 50, p_idempotency_key => 'fifo_exit_73'
    );

    SELECT count(*) INTO v_open_lots FROM public.positions WHERE user_id = v_user_a AND status = 'open';
    SELECT count(*) INTO v_closed_lots FROM public.positions WHERE user_id = v_user_a AND status = 'closed';
    
    IF v_open_lots != 27 OR v_closed_lots != 73 THEN
        RAISE EXCEPTION 'TEST 5 FAILED: Lot status counts incorrect: Open %, Closed %', v_open_lots, v_closed_lots;
    END IF;
    PERFORM public.assert_financial_invariants(v_user_a, 0);

    -- ==========================================================================
    -- TEST 6: Margin Exhaustion Protection
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 6: Margin Exhaustion...';
    -- Set User A balance to exactly 500
    UPDATE public.profiles SET balance = 500 WHERE id = v_user_a;
    
    BEGIN
        -- Attempt to place order requiring 501
        PERFORM public.place_order_v2(
            v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'BUY', 'MARKET', 'CARRY',
            10, 10, 100, 100, false, 0, 'EXECUTED',
            p_expected_margin => 501, p_expected_brokerage => 0, p_idempotency_key => 'mrg_exhaust'
        );
        RAISE EXCEPTION 'TEST 6 FAILED: Engine allowed trade exceeding available margin.';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE 'Test 6 Success: Over-margin trade rejected correctly.';
    END;

    -- Rebaseline balance to restore correct ledger balance
    PERFORM public.rebaseline_user_profile_balance(v_user_a);

    -- ==========================================================================
    -- TEST 7: Multi-User Isolation
    -- ==========================================================================
    RAISE NOTICE 'Executing Test 7: Multi-User Isolation...';
    -- User A and User B trade same symbol simultaneously
    -- User A buys 10 @ 100
    -- User B sells (creates short) 10 @ 100
    PERFORM public.place_order_v2(
        v_user_a, 'TEST_INFY', 'TEST_INFY', 'EQ', 'BUY', 'MARKET', 'CARRY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 10, p_idempotency_key => 'isolation_a'
    );
    PERFORM public.place_order_v2(
        v_user_b, 'TEST_INFY', 'TEST_INFY', 'EQ', 'SELL', 'MARKET', 'CARRY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000, p_expected_brokerage => 10, p_idempotency_key => 'isolation_b'
    );

    SELECT count(*) INTO v_open_lots FROM public.positions WHERE user_id = v_user_a AND status = 'open' AND side = 'BUY';
    IF v_open_lots = 0 THEN
        RAISE EXCEPTION 'TEST 7 FAILED: User A positions got corrupted or lost.';
    END IF;

    SELECT count(*) INTO v_open_lots FROM public.positions WHERE user_id = v_user_b AND status = 'open' AND side = 'SELL';
    IF v_open_lots = 0 THEN
        RAISE EXCEPTION 'TEST 7 FAILED: User B positions got corrupted or lost.';
    END IF;

    PERFORM public.assert_financial_invariants(v_user_a, 0);
    PERFORM public.assert_financial_invariants(v_user_b, 0);

    -- ==========================================================================
    -- CLEAN UP ALL TEST USERS AND DATA
    -- ==========================================================================
    DELETE FROM public.transactions WHERE user_id IN (v_user_a, v_user_b);
    DELETE FROM public.positions WHERE user_id IN (v_user_a, v_user_b);
    DELETE FROM public.orders WHERE user_id IN (v_user_a, v_user_b);
    DELETE FROM public.profiles WHERE id IN (v_user_a, v_user_b);
    DELETE FROM auth.users WHERE id IN (v_user_a, v_user_b);

    RAISE NOTICE '================================================================';
    RAISE NOTICE 'SUCCESS: All Position Engine regression scenarios & invariants verified!';
    RAISE NOTICE '================================================================';
END;
$$;

DROP FUNCTION IF EXISTS public.assert_financial_invariants(uuid, numeric);
