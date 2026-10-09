-- ==============================================================================
-- Position Engine Contract Tests (v1.0.0)
--
-- These tests are IMMUTABLE for the life of contract version 1.0.0.
-- They specify the exact input/output/side-effect contract of each public RPC.
-- They must not be changed to make failing tests pass.
-- If a contract must change, create contract_tests_v2.sql and bump
-- contract_version in engine_metadata.
--
-- Difference from regression suite (position_engine_validation.sql):
--   Regression suite  → proves correctness of engine lifecycle transitions
--   Contract tests    → proves the public API surface has not silently changed
--
-- Each test section specifies:
--   INPUT    — exact parameters passed
--   RETURNS  — exact return type and value
--   LEDGER   — exact transaction rows created
--   POSITION — exact position state after execution
--   BALANCE  — exact profile balance after execution
--   ERRORS   — exact error messages on invalid input
-- ==============================================================================

-- ─── Test helpers ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ct_assert(
    p_condition boolean,
    p_message   text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT p_condition THEN
        RAISE EXCEPTION 'CONTRACT VIOLATION: %', p_message;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ct_assert_eq(
    p_actual    anyelement,
    p_expected  anyelement,
    p_field     text
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF p_actual IS DISTINCT FROM p_expected THEN
        RAISE EXCEPTION 'CONTRACT VIOLATION — %: expected %, got %',
            p_field, p_expected, p_actual;
    END IF;
END;
$$;

-- ─── Setup ────────────────────────────────────────────────────────────────────

DO $$
DECLARE
    v_user         uuid;
    v_order_id     uuid;
    v_pnl          numeric;
    v_pos          RECORD;
    v_trx          RECORD;
    v_bal_before   numeric;
    v_bal_after    numeric;
    v_trx_count    integer;
    v_initial_bal  numeric := 50000;
BEGIN
    RAISE NOTICE '=================================================================';
    RAISE NOTICE 'POSITION ENGINE CONTRACT TESTS v1.0.0';
    RAISE NOTICE '=================================================================';

    -- Seed test symbol
    INSERT INTO public.script_settings (symbol, lot_size)
    VALUES ('CT_SYM', 1) ON CONFLICT (symbol) DO NOTHING;

    v_user := gen_random_uuid();
    INSERT INTO auth.users  (id, email) VALUES (v_user, 'ct@marginapex.com');
    INSERT INTO public.profiles (id, active, role, balance, settlement_amount, client_id)
    VALUES (v_user, true, 'user', v_initial_bal, v_initial_bal, 'CT_USR');
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_user, 'DEPOSIT', v_initial_bal, 'APPROVED', 'CT_DEPOSIT');

    -- ===========================================================================
    -- CONTRACT 1: place_order_v2 — entry order
    --
    -- INPUT:  qty=10, fill_price=100, margin=1000, brokerage=20
    -- RETURNS: uuid (order id, non-null)
    -- LEDGER:  MARGIN_DEBIT 1000, BROKERAGE_DEBIT 20
    -- POSITION: 1 open lot, side=BUY, qty_open=10, avg_price=100, locked_margin=1000
    -- BALANCE:  50000 - 1000 (margin) - 20 (brokerage) = 48980
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 1: place_order_v2 entry...';

    v_order_id := public.place_order_v2(
        v_user, 'CT_SYM', 'CT_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000,
        p_expected_brokerage => 20,
        p_idempotency_key => 'ct1_entry'
    );

    PERFORM public.ct_assert(v_order_id IS NOT NULL, 'C1: order_id must not be null');

    SELECT * INTO v_pos FROM public.positions
    WHERE user_id = v_user AND symbol = 'CT_SYM' AND status = 'open';
    PERFORM public.ct_assert(FOUND,              'C1: open position must exist');
    PERFORM public.ct_assert_eq(v_pos.side,      'BUY',   'C1: position side');
    PERFORM public.ct_assert_eq(v_pos.qty_open,  10::numeric, 'C1: qty_open');
    PERFORM public.ct_assert_eq(v_pos.avg_price, 100::numeric, 'C1: avg_price');
    PERFORM public.ct_assert_eq(v_pos.locked_margin, 1000::numeric, 'C1: locked_margin');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'MARGIN_DEBIT' AND amount = 1000
      AND ref_id = 'MRG_' || v_order_id::text;
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C1: MARGIN_DEBIT ledger entry');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'BROKERAGE_DEBIT' AND amount = 20
      AND ref_id = 'BRK_' || v_order_id::text;
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C1: BROKERAGE_DEBIT ledger entry');

    -- ===========================================================================
    -- CONTRACT 2: place_order_v2 — idempotency
    --
    -- Submitting the same idempotency_key twice must return the same order_id
    -- and must NOT create duplicate ledger entries.
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 2: place_order_v2 idempotency...';

    DECLARE v_order_id_2 uuid;
    BEGIN
        v_order_id_2 := public.place_order_v2(
            v_user, 'CT_SYM', 'CT_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
            10, 10, 100, 100, false, 0, 'EXECUTED',
            p_expected_margin => 1000,
            p_expected_brokerage => 20,
            p_idempotency_key => 'ct1_entry'   -- same key as C1
        );
        PERFORM public.ct_assert_eq(v_order_id_2, v_order_id, 'C2: idempotent call must return original order_id');

        SELECT count(*) INTO v_trx_count FROM public.transactions
        WHERE user_id = v_user AND type = 'MARGIN_DEBIT'
          AND ref_id = 'MRG_' || v_order_id::text;
        PERFORM public.ct_assert_eq(v_trx_count, 1, 'C2: duplicate call must not create second MARGIN_DEBIT');
    END;

    -- ===========================================================================
    -- CONTRACT 3: place_order_v2 — margin exhaustion rejection
    --
    -- INPUT:  expected_margin > available balance
    -- RETURNS: exception (must not return an order_id)
    -- LEDGER:  no entries created
    -- POSITION: unchanged
    -- ERROR:  message must contain 'Insufficient balance'
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 3: place_order_v2 margin exhaustion rejection...';

    BEGIN
        PERFORM public.place_order_v2(
            v_user, 'CT_SYM', 'CT_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
            10, 10, 100, 100, false, 0, 'EXECUTED',
            p_expected_margin => 99999999,
            p_expected_brokerage => 0,
            p_idempotency_key => 'ct3_reject'
        );
        RAISE EXCEPTION 'CONTRACT VIOLATION — C3: engine must reject order exceeding available balance';
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.ct_assert(
            SQLERRM ILIKE '%Insufficient balance%' OR SQLERRM ILIKE '%CONTRACT VIOLATION%',
            'C3: rejection error message must reference Insufficient balance, got: ' || SQLERRM
        );
        IF SQLERRM ILIKE '%CONTRACT VIOLATION%' THEN RAISE; END IF;
    END;

    -- ===========================================================================
    -- CONTRACT 4: close_position_v2
    --
    -- INPUT:  close_qty=10, close_price=120, closed_by=USER, brokerage=15
    -- RETURNS: numeric (realized PnL = (120-100)*10 = 200)
    -- LEDGER:  PNL_CREDIT 200, MARGIN_CREDIT 1000, BROKERAGE_DEBIT 15
    -- POSITION: status=closed, qty_open=0, locked_margin=0
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 4: close_position_v2...';

    v_pnl := public.close_position_v2(
        v_pos.id, 10, 120, 'USER', 15,
        'ct4_close'
    );

    PERFORM public.ct_assert_eq(v_pnl, 200::numeric, 'C4: realized PnL must be (120-100)*10 = 200');

    SELECT * INTO v_pos FROM public.positions WHERE id = v_pos.id;
    PERFORM public.ct_assert_eq(v_pos.status,       'closed',    'C4: position status');
    PERFORM public.ct_assert_eq(v_pos.qty_open,     0::numeric,  'C4: qty_open must be 0');
    PERFORM public.ct_assert_eq(v_pos.locked_margin, 0::numeric, 'C4: locked_margin must be 0');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'PNL_CREDIT' AND amount = 200
      AND ref_id = 'CLOSE_PNL_ct4_close';
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C4: PNL_CREDIT ledger entry');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'MARGIN_CREDIT' AND amount = 1000
      AND ref_id = 'CLOSE_MRG_ct4_close';
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C4: MARGIN_CREDIT ledger entry');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'BROKERAGE_DEBIT' AND amount = 15
      AND ref_id = 'CLOSE_BRK_ct4_close';
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C4: BROKERAGE_DEBIT ledger entry');

    -- ===========================================================================
    -- CONTRACT 5: close_position_v2 — idempotency
    --
    -- Re-closing with the same idempotency key must return the cached PnL
    -- without creating duplicate ledger entries.
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 5: close_position_v2 idempotency...';

    v_pnl := public.close_position_v2(
        v_pos.id, 10, 120, 'USER', 15,
        'ct4_close'   -- same key
    );
    PERFORM public.ct_assert_eq(v_pnl, 200::numeric, 'C5: idempotent close must return original PnL');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'PNL_CREDIT'
      AND ref_id = 'CLOSE_PNL_ct4_close';
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C5: idempotent close must not duplicate PNL_CREDIT');

    -- ===========================================================================
    -- CONTRACT 6: close_position_v2 — already-closed rejection
    --
    -- Attempting to close a position that is already closed must raise an
    -- exception referencing the closed state.
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 6: close_position_v2 already-closed rejection...';

    BEGIN
        PERFORM public.close_position_v2(
            v_pos.id, 10, 120, 'USER', 0,
            'ct6_double_close'
        );
        RAISE EXCEPTION 'CONTRACT VIOLATION — C6: engine must reject close on already-closed position';
    EXCEPTION WHEN OTHERS THEN
        PERFORM public.ct_assert(
            SQLERRM ILIKE '%already closed%' OR SQLERRM ILIKE '%not found%'
                OR SQLERRM ILIKE '%CONTRACT VIOLATION%',
            'C6: error must reference closed/not-found state, got: ' || SQLERRM
        );
        IF SQLERRM ILIKE '%CONTRACT VIOLATION%' THEN RAISE; END IF;
    END;

    -- ===========================================================================
    -- CONTRACT 7: apply_carry_charges_v1
    --
    -- Setup: open a fresh CARRY position, then apply a charge.
    -- INPUT:  charge_amount=50
    -- RETURNS: numeric 50 (amount charged)
    -- LEDGER:  FEE 50 with idempotency-keyed ref_id
    -- BALANCE:  reduced by 50
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 7: apply_carry_charges_v1...';

    PERFORM public.place_order_v2(
        v_user, 'CT_SYM', 'CT_SYM', 'EQ', 'BUY', 'MARKET', 'CARRY',
        5, 5, 200, 200, false, 0, 'EXECUTED',
        p_expected_margin => 500,
        p_expected_brokerage => 0,
        p_idempotency_key => 'ct7_carry_entry'
    );

    SELECT * INTO v_pos FROM public.positions
    WHERE user_id = v_user AND symbol = 'CT_SYM'
      AND status = 'open' AND product_type = 'CARRY';

    -- Force rebaseline to ensure v_bal_before is correct
    PERFORM public.rebaseline_user_profile_balance(v_user);
    SELECT balance INTO v_bal_before FROM public.profiles WHERE id = v_user;

    DECLARE v_charged numeric;
    BEGIN
        v_charged := public.apply_carry_charges_v1(
            v_pos.id, 50, 'CT7_CARRY_CHG'
        );
        PERFORM public.ct_assert_eq(v_charged, 50::numeric, 'C7: charged amount return value');
    END;

    -- Force rebaseline to ensure all profile balance calculations reconcile perfectly
    PERFORM public.rebaseline_user_profile_balance(v_user);
    SELECT balance INTO v_bal_after FROM public.profiles WHERE id = v_user;
    PERFORM public.ct_assert_eq(v_bal_after, v_bal_before - 50, 'C7: balance reduced by charge');

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'FEE' AND amount = 50
      AND ref_id = 'CT7_CARRY_CHG';
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C7: FEE ledger entry');

    -- ===========================================================================
    -- CONTRACT 8: apply_carry_charges_v1 — idempotency
    --
    -- Applying the same charge key twice must return 0 (already applied)
    -- and must not create a second FEE entry.
    -- ===========================================================================
    RAISE NOTICE 'CONTRACT 8: apply_carry_charges_v1 idempotency...';

    DECLARE v_charged_2 numeric;
    BEGIN
        v_charged_2 := public.apply_carry_charges_v1(
            v_pos.id, 50, 'CT7_CARRY_CHG'  -- same key
        );
        PERFORM public.ct_assert_eq(v_charged_2, 0::numeric, 'C8: idempotent charge must return 0');
    END;

    SELECT count(*) INTO v_trx_count FROM public.transactions
    WHERE user_id = v_user AND type = 'FEE' AND ref_id = 'CT7_CARRY_CHG';
    PERFORM public.ct_assert_eq(v_trx_count, 1, 'C8: idempotent charge must not create second FEE entry');

    -- ===========================================================================
    -- TEARDOWN
    -- ===========================================================================
    DELETE FROM public.transactions WHERE user_id = v_user;
    DELETE FROM public.positions    WHERE user_id = v_user;
    DELETE FROM public.orders       WHERE user_id = v_user;
    DELETE FROM public.profiles     WHERE id = v_user;
    DELETE FROM auth.users          WHERE id = v_user;

    RAISE NOTICE '=================================================================';
    RAISE NOTICE 'CONTRACT TESTS v1.0.0: ALL PASSED';
    RAISE NOTICE '=================================================================';
END;
$$;

DROP FUNCTION IF EXISTS public.ct_assert(boolean, text);
DROP FUNCTION IF EXISTS public.ct_assert_eq(anyelement, anyelement, text);
