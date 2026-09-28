-- ==========================================
-- RUPEEFX TRADING UNIFIED DATABASE SETUP SCHEMA
-- Created: 2026-06-08T04:13:10.826Z
-- Combined from 60 migration files.
-- ==========================================

-- ------------------------------------------
-- FILE: 20260419_kite_sessions.sql
-- ------------------------------------------
-- Kite Connect session storage
-- Run this in: supabase.com → your project → SQL Editor

create table if not exists public.kite_sessions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  kite_user_id    text not null,
  access_token    text not null,
  -- Kite tokens expire at 06:00 IST (00:30 UTC) the next day
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- One active session per Supabase user
  unique (user_id)
);

-- Only the authenticated user can read/write their own row
alter table public.kite_sessions enable row level security;

create policy "Users can manage their own kite session"
  on public.kite_sessions
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger kite_sessions_updated_at
  before update on public.kite_sessions
  for each row execute procedure public.set_updated_at();


-- ------------------------------------------
-- FILE: 20260421_profiles.sql
-- ------------------------------------------
-- Extended user profile data
-- Mirrors the pattern in 20260419_kite_sessions.sql

create table if not exists public.profiles (
  id                uuid        primary key references auth.users(id) on delete cascade,
  email             text        not null,
  full_name         text,
  phone             text,
  role              text        not null,
  parent_id         text,
  segments          text[],
  active            boolean     not null default true,
  read_only         boolean     not null default false,
  demo_user         boolean     not null default false,
  intraday_sq_off   boolean     not null default false,
  auto_sqoff        integer     not null default 90,
  showcase_auto_sqoff numeric     not null default 85,
  sqoff_method      text        not null default 'Credit',
  scheduled_delete_at timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Service role only for writes; authenticated users can read their own row
alter table public.profiles enable row level security;

create policy "Service role manages all profiles"
  on public.profiles
  for all
  using  (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

create policy "Users can read their own profile"
  on public.profiles
  for select
  using (auth.uid() = id);

-- Auto-update updated_at (reuses the function from kite_sessions migration)
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute procedure public.set_updated_at();


-- ------------------------------------------
-- FILE: 20260423_approve_rpc.sql
-- ------------------------------------------
CREATE OR REPLACE FUNCTION approve_pay_request(
  request_id UUID,
  admin_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request pay_requests%ROWTYPE;
BEGIN
  -- Lock the row to prevent concurrent approvals
  SELECT * INTO v_request
    FROM pay_requests
   WHERE id = request_id
     FOR UPDATE;

  -- Not found
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Not found', 'code', 404);
  END IF;

  -- Already processed
  IF v_request.status <> 'PENDING' THEN
    RETURN jsonb_build_object('error', 'Request is not pending', 'code', 409);
  END IF;

  -- Update status to APPROVED
  UPDATE pay_requests
     SET status = 'APPROVED',
         updated_at = now()
   WHERE id = request_id;

  -- Insert matching transaction row
  INSERT INTO transactions (user_id, type, amount, created_at)
  VALUES (v_request.user_id, v_request.type, v_request.amount, now());

  RETURN jsonb_build_object('status', 'APPROVED', 'code', 200);
END;
$$;


-- ------------------------------------------
-- FILE: 20260423_pay_requests.sql
-- ------------------------------------------
CREATE TABLE pay_requests (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID        NOT NULL REFERENCES auth.users(id),
  type         TEXT        NOT NULL CHECK (type IN ('DEPOSIT', 'WITHDRAWAL')),
  amount       NUMERIC     NOT NULL CHECK (amount > 0),
  status       TEXT        NOT NULL DEFAULT 'PENDING'
                           CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  account_name TEXT        NULL,
  account_no   TEXT        NULL,
  ifsc         TEXT        NULL,
  upi          TEXT        NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER pay_requests_updated_at
  BEFORE UPDATE ON pay_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE pay_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own_pay_requests"
  ON pay_requests FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "users_insert_own_pay_requests"
  ON pay_requests FOR INSERT
  WITH CHECK (auth.uid() = user_id);


-- ------------------------------------------
-- FILE: 20260423_wallet_rules.sql
-- ------------------------------------------
CREATE TABLE wallet_rules (
  id               INTEGER     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  withdraw_enabled BOOLEAN     NOT NULL DEFAULT true,
  allowed_days     TEXT[]      NOT NULL DEFAULT '{Monday,Tuesday,Wednesday,Thursday,Friday}',
  start_time       TIME        NOT NULL DEFAULT '10:00',
  end_time         TIME        NOT NULL DEFAULT '16:00',
  min_withdraw     NUMERIC     NOT NULL DEFAULT 100,
  min_deposit      NUMERIC     NOT NULL DEFAULT 1000,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the single configuration row
INSERT INTO wallet_rules (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;


-- ------------------------------------------
-- FILE: 20260424_payment_accounts.sql
-- ------------------------------------------
-- Migration: payment_accounts table
-- Requirements: 20.1, 20.2, 20.3, 20.4

CREATE TABLE payment_accounts (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_holder TEXT        NOT NULL,
  bank_name      TEXT        NOT NULL,
  account_no     TEXT        NOT NULL,
  ifsc           TEXT        NOT NULL,
  upi_id         TEXT        NOT NULL,
  qr_image_url   TEXT        NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT true,
  sort_order     INTEGER     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reuse existing set_updated_at() trigger function (created in 20260423_pay_requests.sql)
CREATE TRIGGER payment_accounts_updated_at
  BEFORE UPDATE ON payment_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- No user-facing RLS; all access via service role


-- ------------------------------------------
-- FILE: 20260425_pay_requests_add_account.sql
-- ------------------------------------------
-- Migration: pay_requests table extension — add payment_account_id column
-- Depends on: 20260424_payment_accounts.sql (payment_accounts table must exist first)
-- Requirements: 21.1, 21.2, 21.3

ALTER TABLE pay_requests
  ADD COLUMN payment_account_id UUID NULL REFERENCES payment_accounts(id);


-- ------------------------------------------
-- FILE: 20260501_profiles_extend.sql
-- ------------------------------------------
-- Extend profiles table with any missing columns (idempotent)
-- Note: profiles table already exists from 20260421_profiles.sql
-- These are safe no-ops if columns already exist

alter table if exists public.profiles
  add column if not exists full_name text;

alter table if exists public.profiles
  add column if not exists phone text;

alter table if exists public.profiles
  add column if not exists segments text[];

alter table if exists public.profiles
  add column if not exists active bool default true;

alter table if exists public.profiles
  add column if not exists read_only bool default false;

alter table if exists public.profiles
  add column if not exists demo_user bool default false;

alter table if exists public.profiles
  add column if not exists intraday_sq_off bool default false;

alter table if exists public.profiles
  add column if not exists auto_sqoff numeric default 90;
  
  alter table public.profiles
  add column if not exists showcase_auto_sqoff numeric default 85;

alter table if exists public.profiles
  add column if not exists sqoff_method text default 'Credit';

alter table if exists public.profiles
  add column if not exists scheduled_delete_at timestamptz;


-- ------------------------------------------
-- FILE: 20260502_orders.sql
-- ------------------------------------------
create table if not exists public.orders (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  symbol      text        not null,
  side        text        not null check (side in ('BUY','SELL')),
  status      text        not null check (status in ('EXECUTED','CANCELLED','REJECTED')),
  qty         numeric     not null,
  price       numeric     not null,
  order_type  text        not null check (order_type in ('MARKET','LIMIT')),
  info        text,
  created_at  timestamptz not null default now()
);

create index if not exists orders_user_id_idx on public.orders(user_id);
create index if not exists orders_status_idx  on public.orders(status);

alter table public.orders enable row level security;

create policy "Service role manages all orders"
  on public.orders for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260503_positions.sql
-- ------------------------------------------
create table if not exists public.positions (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references public.profiles(id) on delete cascade,
  symbol           text        not null,
  side             text        not null check (side in ('BUY','SELL')),
  status           text        not null check (status in ('open','active','closed')),
  pnl              numeric     not null default 0,
  qty_open         numeric     not null default 0,
  qty_total        numeric     not null default 0,
  avg_price        numeric     not null default 0,
  entry_price      numeric     not null default 0,
  ltp              numeric,
  exit_price       numeric,
  duration_seconds integer     not null default 0,
  brokerage        numeric     not null default 0,
  sl               numeric,
  tp               numeric,
  entry_time       timestamptz not null default now(),
  exit_time        timestamptz,
  settlement       text,
  closed_by        text default 'USER',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists positions_user_id_idx on public.positions(user_id);
create index if not exists positions_status_idx  on public.positions(status);

alter table public.positions enable row level security;

create policy "Service role manages all positions"
  on public.positions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260503_profiles_kyc.sql
-- ------------------------------------------
-- Extended profile fields: personal, KYC, bank details
-- All columns nullable — users fill gradually

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS date_of_birth text,
    ADD COLUMN IF NOT EXISTS city          text,
    ADD COLUMN IF NOT EXISTS state         text,
    ADD COLUMN IF NOT EXISTS pan_number    text,
    ADD COLUMN IF NOT EXISTS address       text,
    ADD COLUMN IF NOT EXISTS pincode       text,
    ADD COLUMN IF NOT EXISTS aadhar_number text,
    ADD COLUMN IF NOT EXISTS bank_name     text,
    ADD COLUMN IF NOT EXISTS account_no    text,
    ADD COLUMN IF NOT EXISTS ifsc          text;


-- ------------------------------------------
-- FILE: 20260504_transactions.sql
-- ------------------------------------------
create table if not exists public.transactions (
  id           uuid        primary key default gen_random_uuid(),
  user_id      uuid        not null references public.profiles(id) on delete cascade,
  type         text        not null check (type in ('DEPOSIT','WITHDRAWAL')),
  amount       numeric     not null,
  status       text        not null default 'PENDING' check (status in ('APPROVED','PENDING','REJECTED')),
  ref_id       text,
  broker_id    text,
  account_name text,
  account_no   text,
  ifsc         text,
  upi          text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists transactions_user_id_idx on public.transactions(user_id);
create index if not exists transactions_type_idx    on public.transactions(type);
create index if not exists transactions_status_idx  on public.transactions(status);

alter table public.transactions enable row level security;

create policy "Service role manages all transactions"
  on public.transactions for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260505070005_fix_approve_transaction_status.sql
-- ------------------------------------------
CREATE OR REPLACE FUNCTION approve_pay_request(
  request_id UUID,
  admin_id   UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_request pay_requests%ROWTYPE;
BEGIN
  -- Lock the row to prevent concurrent approvals
  SELECT * INTO v_request
    FROM pay_requests
   WHERE id = request_id
     FOR UPDATE;

  -- Not found
  IF NOT FOUND THEN
    RETURN jsonb_build_object('error', 'Not found', 'code', 404);
  END IF;

  -- Already processed
  IF v_request.status <> 'PENDING' THEN
    RETURN jsonb_build_object('error', 'Request is not pending', 'code', 409);
  END IF;

  -- Update status to APPROVED
  UPDATE pay_requests
     SET status = 'APPROVED',
         updated_at = now()
   WHERE id = request_id;

  -- Insert matching transaction row WITH status APPROVED
  INSERT INTO transactions (user_id, type, amount, status, created_at)
  VALUES (v_request.user_id, v_request.type, v_request.amount, 'APPROVED', now());

  RETURN jsonb_build_object('status', 'APPROVED', 'code', 200);
END;
$$;

-- Fix any existing transactions that were erroneously created as PENDING when they were approved deposits/withdrawals.
-- Since all transactions created from pay_requests SHOULD be approved upon insertion by the RPC,
-- any PENDING DEPOSIT/WITHDRAWAL should be updated to APPROVED.
UPDATE transactions 
SET status = 'APPROVED' 
WHERE status = 'PENDING' AND type IN ('DEPOSIT', 'WITHDRAWAL');


-- ------------------------------------------
-- FILE: 20260505_act_logs.sql
-- ------------------------------------------
create table if not exists public.act_logs (
  id             uuid        primary key default gen_random_uuid(),
  type           text        not null check (type in ('ORDER_EXECUTION','AUTO_SQUARE_OFF','ORDER_CANCEL','LOGIN','LOGOUT')),
  user_id        uuid        references public.profiles(id) on delete set null,
  target_user_id uuid        references public.profiles(id) on delete set null,
  symbol         text,
  qty            numeric,
  price          numeric,
  reason         text,
  ip             text,
  created_at     timestamptz not null default now()
);

create index if not exists act_logs_created_at_idx on public.act_logs(created_at desc);
create index if not exists act_logs_user_id_idx    on public.act_logs(user_id);

alter table public.act_logs enable row level security;

create policy "Service role manages all act_logs"
  on public.act_logs for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260506_watchlists.sql
-- ------------------------------------------
create table if not exists public.watchlists (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references public.profiles(id) on delete cascade,
  tab        text        not null,
  symbol     text        not null,
  created_at timestamptz not null default now(),
  unique (user_id, tab, symbol)
);

create index if not exists watchlists_user_tab_idx on public.watchlists(user_id, tab);

alter table public.watchlists enable row level security;

create policy "Service role manages all watchlists"
  on public.watchlists for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260507_script_settings.sql
-- ------------------------------------------
create table if not exists public.script_settings (
  id         uuid        primary key default gen_random_uuid(),
  symbol     text        not null unique,
  lot_size   numeric     not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.script_settings enable row level security;

create policy "Service role manages all script_settings"
  on public.script_settings for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260508_segment_settings.sql
-- ------------------------------------------
create table if not exists public.segment_settings (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.profiles(id) on delete cascade,
  segment             text        not null,
  side                text        not null check (side in ('BUY','SELL')),
  commission_type     text        not null default 'Per Crore',
  commission_value    numeric     not null default 4500,
  profit_hold_sec     integer     not null default 120,
  loss_hold_sec       integer     not null default 0,
  strike_range        numeric     not null default 0,
  max_lot             numeric     not null default 50,
  max_order_lot       numeric     not null default 50,
  intraday_leverage   numeric     not null default 50,
  intraday_type       text        not null default 'Multiplier',
  holding_leverage    numeric     not null default 5,
  entry_buffer        numeric     not null default 0.003,
  holding_type        text        not null default 'Multiplier',
  exit_buffer         numeric     not null default 0.0017,
  trade_allowed       boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, segment, side)
);

create index if not exists segment_settings_user_id_idx on public.segment_settings(user_id);

alter table public.segment_settings enable row level security;

create policy "Service role manages all segment_settings"
  on public.segment_settings for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260509_dashboard_cache.sql
-- ------------------------------------------
create table if not exists public.dashboard_cache (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references public.profiles(id) on delete cascade,
  date_from   date,
  date_to     date,
  metrics     jsonb       not null,
  computed_at timestamptz not null default now(),
  unique (user_id, date_from, date_to)
);

alter table public.dashboard_cache enable row level security;

create policy "Service role manages all dashboard_cache"
  on public.dashboard_cache for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260510_orders_extend.sql
-- ------------------------------------------
-- ─── Orders: add execution columns ───────────────────────────────────────────
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS segment        text,
  ADD COLUMN IF NOT EXISTS product_type   text
    CHECK (product_type IN ('INTRADAY','CARRY')),
  ADD COLUMN IF NOT EXISTS lots           numeric,
  ADD COLUMN IF NOT EXISTS fill_price     numeric,       -- actual platform fill (LTP ± buffer)
  ADD COLUMN IF NOT EXISTS ltp_at_entry   numeric,       -- raw Kite LTP at moment of order
  ADD COLUMN IF NOT EXISTS kite_instrument text,         -- Kite quote key e.g. "NSE:RELIANCE"
  ADD COLUMN IF NOT EXISTS updated_at     timestamptz NOT NULL DEFAULT now();

-- Expand status to include PENDING (future limit-order engine)
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('PENDING','EXECUTED','CANCELLED','REJECTED'));

-- ─── Transactions: add P&L settlement types ───────────────────────────────────
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('DEPOSIT','WITHDRAWAL','PNL_CREDIT','PNL_DEBIT'));

-- updated_at trigger for orders (reuses existing set_updated_at function)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'orders_updated_at' AND tgrelid = 'public.orders'::regclass
  ) THEN
    CREATE TRIGGER orders_updated_at
      BEFORE UPDATE ON public.orders
      FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();
  END IF;
END;
$$;


-- ------------------------------------------
-- FILE: 20260511_order_rpcs.sql
-- ------------------------------------------
-- ─── place_order() ────────────────────────────────────────────────────────────
-- Atomically inserts an order row, opens/updates a position, and writes
-- an audit log entry. Called server-side after all validation is done.
--
-- Returns: the new order UUID

CREATE OR REPLACE FUNCTION public.place_order(
  p_user_id        uuid,
  p_symbol         text,
  p_kite_inst      text,    -- Kite quote key e.g. "NSE:RELIANCE"
  p_segment        text,
  p_side           text,    -- 'BUY' | 'SELL'
  p_order_type     text,    -- 'MARKET' | 'LIMIT' | 'SL' | 'SLM' | 'GTT'
  p_product_type   text,    -- 'INTRADAY' | 'CARRY'
  p_qty            numeric,
  p_lots           numeric,
  p_ltp            numeric,   -- raw Kite LTP (server-fetched)
  p_fill_price     numeric,   -- target price or ltp ± buffer
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
BEGIN
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price
  )
  RETURNING id INTO v_order_id;

  -- 2. Open a position ONLY if EXECUTED
  IF v_status = 'EXECUTED' THEN
    INSERT INTO public.positions (
      user_id, symbol, side, status,
      qty_total, qty_open,
      avg_price, entry_price, ltp,
      settlement
    )
    VALUES (
      p_user_id, p_symbol, p_side, 'open',
      p_qty, p_qty,
      p_fill_price, p_fill_price, p_ltp,
      p_segment
    );
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;


-- ─── close_position() ─────────────────────────────────────────────────────────
-- Closes an open position, computes realised P&L, writes a PNL transaction,
-- records the exit order, and logs to act_logs.
--
-- Returns: realised P&L (positive = profit, negative = loss)

CREATE OR REPLACE FUNCTION public.close_position(
  p_position_id   uuid,
  p_user_id       uuid,       -- must match position owner (server enforces)
  p_ltp           numeric,    -- raw Kite LTP at close
  p_exit_price    numeric,    -- ltp ± exit_buffer (server-computed)
  p_closed_by     text DEFAULT 'USER'   -- 'USER' | 'BROKER' | 'AUTO_SQOFF'
)
RETURNS numeric               -- realised P&L
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pos          record;
  v_pnl          numeric;
  v_pnl_type     text;
  v_duration_sec integer;
BEGIN
  -- Fetch & lock the position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE id = p_position_id AND user_id = p_user_id AND status = 'open'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Position not found or already closed';
  END IF;

  -- Compute P&L
  IF v_pos.side = 'BUY' THEN
    v_pnl := (p_exit_price - v_pos.entry_price) * v_pos.qty_open;
  ELSE
    v_pnl := (v_pos.entry_price - p_exit_price) * v_pos.qty_open;
  END IF;

  -- Duration
  v_duration_sec := EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer;

  -- 1. Close the position
  UPDATE public.positions
  SET
    status           = 'closed',
    exit_price       = p_exit_price,
    exit_time        = now(),
    ltp              = p_ltp,
    pnl              = v_pnl,
    qty_open         = 0,
    duration_seconds = v_duration_sec,
    updated_at       = now()
  WHERE id = p_position_id;

  -- 2. Record exit order
  INSERT INTO public.orders (
    user_id, symbol, segment, side, status,
    qty, price, fill_price, ltp_at_entry,
    order_type, product_type, info, is_exit
  )
  VALUES (
    p_user_id, v_pos.symbol, v_pos.settlement, 
    CASE WHEN v_pos.side = 'BUY' THEN 'SELL' ELSE 'BUY' END,
    'EXECUTED',
    v_pos.qty_open, p_exit_price, p_exit_price, p_ltp,
    'MARKET', 'INTRADAY',
    'Exit - ' || p_closed_by,
    true
  );

  -- 3. P&L settlement transaction
  v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;

  INSERT INTO public.transactions (
    user_id, type, amount, status, ref_id
  )
  VALUES (
    p_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED',
    p_position_id::text
  );

  -- 4. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN p_closed_by = 'AUTO_SQOFF' THEN 'AUTO_SQUARE_OFF' ELSE 'ORDER_EXECUTION' END,
    p_user_id, p_user_id,
    v_pos.symbol, v_pos.qty_open, p_exit_price,
    p_closed_by,
    p_exit_price,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

  RETURN v_pnl;
END;
$$;


-- Grant execute to service role only
REVOKE ALL ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_position(uuid, uuid, numeric, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_position(uuid, uuid, numeric, numeric, text) TO service_role;


-- ------------------------------------------
-- FILE: 20260512_auth_trigger_broker_ref.sql
-- ------------------------------------------
-- ============================================================
-- Broker Referral: handle_new_user trigger (idempotent)
-- Run this in Supabase SQL Editor.
-- It drops any existing handle_new_user function+trigger first,
-- then creates a clean single trigger that safely upserts the
-- profile row and maps broker_ref -> parent_id.
-- ============================================================

-- 1. Drop the old trigger first (if it exists)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

-- 2. Drop the old function (if it exists)
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

-- 3. Create the new function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role,
    parent_id
  )
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    NULLIF(TRIM(NEW.raw_user_meta_data->>'broker_ref'), '')
  )
  ON CONFLICT (id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    role      = COALESCE(public.profiles.role, EXCLUDED.role);

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Attach the trigger
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();


-- ------------------------------------------
-- FILE: 20260512_notifications.sql
-- ------------------------------------------
-- Notifications table for user-facing alerts
-- Types cover: orders, positions, funds, account status

CREATE TABLE IF NOT EXISTS public.notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL CHECK (type IN (
               'ORDER_EXECUTED', 'ORDER_REJECTED', 'ORDER_CANCELLED',
               'POSITION_OPENED', 'POSITION_CLOSED',
               'DEPOSIT_APPROVED', 'DEPOSIT_REJECTED',
               'WITHDRAWAL_APPROVED', 'WITHDRAWAL_REJECTED',
               'ACCOUNT_SUSPENDED', 'ACCOUNT_READONLY',
               'ACCOUNT_DELETE_SCHEDULED', 'TRADE_DISABLED',
               'GENERAL'
             )),
  title      TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  read       BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_user_id_idx ON public.notifications(user_id);
CREATE INDEX IF NOT EXISTS notifications_read_idx    ON public.notifications(user_id, read);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (for server-side inserts from triggers/API)
CREATE POLICY "Service role manages all notifications"
  ON public.notifications FOR ALL
  USING  (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Users can read their own notifications
CREATE POLICY "Users can read own notifications"
  ON public.notifications FOR SELECT
  USING (auth.uid() = user_id);

-- Users can mark their own notifications as read
CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ------------------------------------------
-- FILE: 20260513_otp_verifications.sql
-- ------------------------------------------
-- OTP verifications table for custom email verification flow
CREATE TABLE IF NOT EXISTS public.otp_verifications (
  email       text        PRIMARY KEY,
  otp_hash    text        NOT NULL,
  full_name   text        NOT NULL,
  broker_ref  text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- No RLS needed — only accessible via service role in API routes
ALTER TABLE public.otp_verifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages otp_verifications"
  ON public.otp_verifications
  FOR ALL
  USING  (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- Auto-clean expired OTPs (optional scheduled job or called inline)
CREATE OR REPLACE FUNCTION public.cleanup_expired_otps()
RETURNS void AS $$
BEGIN
  DELETE FROM public.otp_verifications WHERE expires_at < now();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ------------------------------------------
-- FILE: 20260514_otp_flow_hardening.sql
-- ------------------------------------------
-- ── 1. otp_verifications table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.otp_verifications (
  email       text        PRIMARY KEY,
  otp_hash    text        NOT NULL,
  full_name   text        NOT NULL,
  broker_ref  text,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Allow the created_at column to be updated on upsert (for rate-limit refresh)
ALTER TABLE public.otp_verifications
  ALTER COLUMN created_at SET DEFAULT now();

-- ── 2. RLS — service role bypasses RLS automatically in Postgres; enabling RLS
--    here only blocks anon/authenticated roles from reading OTP hashes directly.
ALTER TABLE public.otp_verifications ENABLE ROW LEVEL SECURITY;

-- Drop the old policy (if name changed) and recreate cleanly
DROP POLICY IF EXISTS "Service role manages otp_verifications" ON public.otp_verifications;

-- Block ALL direct access from anon/authenticated JWT roles.
-- API routes use the service-role key which bypasses RLS entirely in Postgres.
-- No explicit USING/WITH CHECK needed — absence of a matching policy = denied.

-- ── 3. Auto-cleanup function ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.cleanup_expired_otps()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.otp_verifications WHERE expires_at < now();
END;
$$;

-- ── 4. handle_new_user trigger (broker_ref → parent_id) ──────────────────────
-- Drops and recreates to ensure it is always in sync with the current schema.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role,
    parent_id,
    active
  )
  VALUES (
    NEW.id,
    NEW.email,
    NEW.raw_user_meta_data->>'full_name',
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    -- broker_ref in user_metadata must be a UUID (the broker's profile id)
    NULLIF(TRIM(NEW.raw_user_meta_data->>'broker_ref'), ''),
    true
  )
  ON CONFLICT (id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    role      = COALESCE(public.profiles.role, EXCLUDED.role),
    active    = true;

  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();


-- ------------------------------------------
-- FILE: 20260515_pay_requests_add_utr.sql
-- ------------------------------------------
-- Migration: pay_requests table extension — add utr column
-- Requires: 20260423_pay_requests.sql

-- Add the column allowing NULLs initially for existing withdrawal and old deposit records
ALTER TABLE pay_requests
  ADD COLUMN utr TEXT NULL;

-- Enforce global uniqueness on UTR to prevent duplicate claims
ALTER TABLE pay_requests
  ADD CONSTRAINT unique_utr UNIQUE (utr);


-- ------------------------------------------
-- FILE: 20260516_pay_requests_add_screenshot.sql
-- ------------------------------------------
-- Migration: pay_requests table extension — add screenshot_url column
-- Requires: 20260423_pay_requests.sql

ALTER TABLE pay_requests
  ADD COLUMN screenshot_url TEXT NULL;


-- ------------------------------------------
-- FILE: 20260517_storage_payments_bucket.sql
-- ------------------------------------------
-- Create the 'payments' bucket if it doesn't exist
INSERT INTO storage.buckets (id, name, public)
VALUES ('payments', 'payments', true)
ON CONFLICT (id) DO NOTHING;

-- Allow public access to read files in the 'payments' bucket
CREATE POLICY "Public Access" ON storage.objects
  FOR SELECT USING (bucket_id = 'payments');

-- Allow authenticated users to upload files to the 'payments' bucket
CREATE POLICY "Authenticated Upload" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'payments' 
    AND auth.role() = 'authenticated'
  );


-- ------------------------------------------
-- FILE: 20260518_enable_realtime_pay_requests.sql
-- ------------------------------------------
-- Enable full replication identity to ensure all columns are available in realtime events
ALTER TABLE public.pay_requests REPLICA IDENTITY FULL;

-- Add the table to the supabase_realtime publication
-- We use a DO block to handle cases where it might already be added
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'pay_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.pay_requests;
  END IF;
END $$;

-- Policy to allow admins and super_admins to view all pay requests
-- This is required for realtime subscriptions to receive events for all users
DROP POLICY IF EXISTS "Admins can view all pay_requests" ON public.pay_requests;
CREATE POLICY "Admins can view all pay_requests"
  ON public.pay_requests
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles 
      WHERE id = auth.uid() 
      AND role IN ('admin', 'super_admin')
    )
  );


-- ------------------------------------------
-- FILE: 20260519_market_data.sql
-- ------------------------------------------
-- Create instruments table to cache Kite Connect instruments list
CREATE TABLE IF NOT EXISTS public.instruments (
  id text primary key, -- exchange:tradingsymbol (e.g. NSE:RELIANCE)
  instrument_token bigint not null,
  tradingsymbol text not null,
  name text,
  exchange text,
  instrument_type text,
  segment text,
  updated_at timestamptz default now()
);

-- Index for querying by segment/type quickly
CREATE INDEX IF NOT EXISTS idx_instruments_segment_type ON public.instruments(segment, instrument_type);

-- Create market_quotes table to store latest prices
CREATE TABLE IF NOT EXISTS public.market_quotes (
  id text primary key references public.instruments(id) on delete cascade,
  last_price numeric,
  open numeric,
  high numeric,
  low numeric,
  close numeric,
  volume bigint,
  quote_timestamp timestamptz,
  updated_at timestamptz default now()
);

-- Enable RLS
ALTER TABLE public.instruments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.market_quotes ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (handled automatically by Supabase for service_role)
-- Allow authenticated users to SELECT
CREATE POLICY "Allow authenticated users to read instruments" 
  ON public.instruments FOR SELECT TO authenticated USING (true);

CREATE POLICY "Allow authenticated users to read market_quotes" 
  ON public.market_quotes FOR SELECT TO authenticated USING (true);


-- ------------------------------------------
-- FILE: 20260519_order_targets.sql
-- ------------------------------------------
-- Migration: Add Stop Loss and Target fields

-- 1. Add columns to orders
ALTER TABLE public.orders 
ADD COLUMN IF NOT EXISTS stop_loss numeric,
ADD COLUMN IF NOT EXISTS target numeric;

-- 2. Add columns to positions
ALTER TABLE public.positions 
ADD COLUMN IF NOT EXISTS stop_loss numeric,
ADD COLUMN IF NOT EXISTS target numeric;

-- Drop old function to prevent ambiguous call errors due to signature mismatch
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric);

-- 3. Replace place_order function to accept p_stop_loss and p_target
CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
BEGIN
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target
  )
  RETURNING id INTO v_order_id;

  -- 2. Open a position ONLY if EXECUTED
  IF v_status = 'EXECUTED' THEN
    INSERT INTO public.positions (
      user_id, symbol, side, status,
      qty_total, qty_open,
      avg_price, entry_price, ltp,
      settlement, stop_loss, target
    )
    VALUES (
      p_user_id, p_symbol, p_side, 'open',
      p_qty, p_qty,
      p_fill_price, p_fill_price, p_ltp,
      p_segment, p_stop_loss, p_target
    );
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;

-- Redefine grants
REVOKE ALL ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric) TO service_role;


-- ------------------------------------------
-- FILE: 20260520_instrument_expiry.sql
-- ------------------------------------------
-- Add expiry column to instruments table to support front-month contract mapping
ALTER TABLE public.instruments ADD COLUMN expiry date;

-- Index for querying by expiry quickly
CREATE INDEX IF NOT EXISTS idx_instruments_expiry ON public.instruments(expiry);


-- ------------------------------------------
-- FILE: 20260520_positions_product_type.sql
-- ------------------------------------------
-- Add product_type column to positions table
ALTER TABLE public.positions
  ADD COLUMN IF NOT EXISTS product_type text
    CHECK (product_type IN ('INTRADAY', 'CARRY'))
    DEFAULT 'INTRADAY';

-- Drop and recreate place_order to save product_type into positions
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
BEGIN
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target
  )
  RETURNING id INTO v_order_id;

  -- 2. Open a position ONLY if EXECUTED
  IF v_status = 'EXECUTED' THEN
    INSERT INTO public.positions (
      user_id, symbol, side, status,
      qty_total, qty_open,
      avg_price, entry_price, ltp,
      settlement, product_type, stop_loss, target
    )
    VALUES (
      p_user_id, p_symbol, p_side, 'open',
      p_qty, p_qty,
      p_fill_price, p_fill_price, p_ltp,
      p_segment, p_product_type, p_stop_loss, p_target
    );
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;

-- Redefine grants
REVOKE ALL ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric) TO service_role;


-- ------------------------------------------
-- FILE: 20260521_user_bank_accounts.sql
-- ------------------------------------------
-- Migration: Create user_bank_accounts table for saved withdrawal accounts

CREATE TABLE IF NOT EXISTS public.user_bank_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    account_name TEXT NOT NULL,
    account_no TEXT NOT NULL,
    ifsc TEXT NOT NULL,
    bank_name TEXT,
    upi_id TEXT,
    is_primary BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.user_bank_accounts ENABLE ROW LEVEL SECURITY;

-- Policies
CREATE POLICY "Users can view their own bank accounts" 
ON public.user_bank_accounts FOR SELECT 
USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own bank accounts" 
ON public.user_bank_accounts FOR INSERT 
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own bank accounts" 
ON public.user_bank_accounts FOR UPDATE 
USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own bank accounts"
ON public.user_bank_accounts FOR DELETE 
USING (auth.uid() = user_id);

-- Update trigger for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_user_bank_accounts_updated_at
    BEFORE UPDATE ON public.user_bank_accounts
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();


-- ------------------------------------------
-- FILE: 20260522_option_instruments.sql
-- ------------------------------------------
-- Add strike_price, option_type, and underlying_symbol to instruments table
ALTER TABLE public.instruments 
ADD COLUMN IF NOT EXISTS strike_price numeric,
ADD COLUMN IF NOT EXISTS option_type text,
ADD COLUMN IF NOT EXISTS underlying_symbol text;

-- Index for faster filtering in the option chain
CREATE INDEX IF NOT EXISTS idx_instruments_option_lookup 
ON public.instruments(underlying_symbol, expiry, strike_price);


-- ------------------------------------------
-- FILE: 20260523_expand_order_types.sql
-- ------------------------------------------
-- Expand order types and status
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_order_type_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_order_type_check
  CHECK (order_type IN ('MARKET','LIMIT','SL','SLM','GTT'));

-- Ensure status check also has PENDING (already added in 20260510 but double checking)
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_status_check;

ALTER TABLE public.orders
  ADD CONSTRAINT orders_status_check
  CHECK (status IN ('PENDING','EXECUTED','CANCELLED','REJECTED','TRIGGERED'));

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS trigger_price numeric;


-- ------------------------------------------
-- FILE: 20260524_fix_handle_new_user.sql
-- ------------------------------------------
-- Fix handle_new_user trigger to be robust against schema changes.
-- The trigger previously failed silently because:
--   1. It did not handle all NOT NULL columns (e.g. balance, email)
--   2. parent_id FK validation could fail if broker_ref was not a valid UUID
-- This version uses a BEGIN/EXCEPTION block so any failure is logged and graceful.

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_user() CASCADE;

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id,
    email,
    full_name,
    role,
    parent_id,
    active,
    balance
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'role', 'user'),
    -- Only set parent_id if broker_ref is a valid non-empty UUID
    NULLIF(TRIM(COALESCE(NEW.raw_user_meta_data->>'broker_ref', '')), ''),
    true,
    0  -- new users start with zero balance
  )
  ON CONFLICT (id) DO UPDATE SET
    parent_id = EXCLUDED.parent_id,
    full_name = COALESCE(EXCLUDED.full_name, public.profiles.full_name),
    role      = COALESCE(public.profiles.role, EXCLUDED.role),
    active    = true;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Log the error but don't block user creation
  RAISE WARNING 'handle_new_user failed for %: % %', NEW.email, SQLERRM, SQLSTATE;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE PROCEDURE public.handle_new_user();


-- ------------------------------------------
-- FILE: 20260524_trading_hours.sql
-- ------------------------------------------
-- 20260524_trading_hours.sql
-- Table to manage market segment trading hours

CREATE TABLE IF NOT EXISTS public.trading_hours (
  id          text        PRIMARY KEY, -- e.g. 'nse', 'mcx'
  name        text        NOT NULL,
  start_time  text        NOT NULL DEFAULT '09:15',
  end_time    text        NOT NULL DEFAULT '15:30',
  is_active   boolean     NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Initial data
INSERT INTO public.trading_hours (id, name, start_time, end_time, is_active)
VALUES 
  ('nse', 'NSE Equity', '09:15', '15:30', true),
  ('bse', 'BSE Equity', '09:15', '15:30', true),
  ('mcx', 'MCX Commodities', '09:00', '23:30', true),
  ('forex', 'FOREX', '00:00', '23:59', true),
  ('comex', 'COMEX', '00:00', '23:59', true)
ON CONFLICT (id) DO NOTHING;

-- RLS
ALTER TABLE public.trading_hours ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages trading_hours"
  ON public.trading_hours FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Authenticated users can read trading_hours"
  ON public.trading_hours FOR SELECT
  USING (auth.role() = 'authenticated');


-- ------------------------------------------
-- FILE: 20260525_user_blocked_scripts.sql
-- ------------------------------------------
-- 20260525_user_blocked_scripts.sql
-- Table to manage blocked scripts per user

CREATE TABLE IF NOT EXISTS public.user_blocked_scripts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  symbol      text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, symbol)
);

-- RLS
ALTER TABLE public.user_blocked_scripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages all user_blocked_scripts"
  ON public.user_blocked_scripts FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users can read their own blocked scripts"
  ON public.user_blocked_scripts FOR SELECT
  USING (auth.uid() = user_id);


-- ------------------------------------------
-- FILE: 20260526_sync_profile_balance.sql
-- ------------------------------------------
-- Trigger to keep profiles.balance in sync with approved transactions
-- This ensures that manual ledger updates and approved pay-ins/outs are reflected in the user's balance.

CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'APPROVED') THEN
    UPDATE public.profiles
    SET balance = balance + (CASE WHEN NEW.type = 'DEPOSIT' THEN NEW.amount ELSE -NEW.amount END),
        updated_at = now()
    WHERE id = NEW.user_id;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- If status changed to APPROVED
    IF (OLD.status <> 'APPROVED' AND NEW.status = 'APPROVED') THEN
      UPDATE public.profiles
      SET balance = balance + (CASE WHEN NEW.type = 'DEPOSIT' THEN NEW.amount ELSE -NEW.amount END),
          updated_at = now()
      WHERE id = NEW.user_id;
    -- If an APPROVED transaction is deleted (rare, but for safety)
    ELSIF (OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED') THEN
      UPDATE public.profiles
      SET balance = balance - (CASE WHEN OLD.type = 'DEPOSIT' THEN OLD.amount ELSE -OLD.amount END),
          updated_at = now()
      WHERE id = OLD.user_id;
    END IF;
  ELSIF (TG_OP = 'DELETE' AND OLD.status = 'APPROVED') THEN
    UPDATE public.profiles
    SET balance = balance - (CASE WHEN OLD.type = 'DEPOSIT' THEN OLD.amount ELSE -OLD.amount END),
        updated_at = now()
    WHERE id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS transactions_balance_sync ON public.transactions;
CREATE TRIGGER transactions_balance_sync
AFTER INSERT OR UPDATE OR DELETE ON public.transactions
FOR EACH ROW EXECUTE FUNCTION public.sync_profile_balance();

-- Initial sync: Ensure all profiles have balance reflecting their approved transactions
-- WARNING: This assumes existing balance was 0 or incorrect. 
-- In a production environment, you'd calculate the sum and update once.
-- For this setup, we'll perform a one-time update.

UPDATE public.profiles p
SET balance = COALESCE((
  SELECT SUM(CASE WHEN type = 'DEPOSIT' THEN amount ELSE -amount END)
  FROM public.transactions
  WHERE user_id = p.id AND status = 'APPROVED'
), 0);


-- ------------------------------------------
-- FILE: 20260527_positions_add_margin.sql
-- ------------------------------------------
-- Add margin_required to positions table
-- This allows accurate tracking of margin used by each user in real-time.

alter table if exists public.positions
  add column if not exists margin_required numeric default 0;

-- Optionally, if we have orders that were recently executed, we could try to backfill
-- But for now, we'll just ensure new positions have this data.


-- ------------------------------------------
-- FILE: 20260528_positions_calculate_margin_trigger.sql
-- ------------------------------------------
-- Database trigger for real-time margin_required calculation on positions table.
-- Automatically computes NEW.margin_required on insert and update based on leverage.

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
  IF NEW.status = 'closed' OR NEW.qty_open = 0 THEN
    IF TG_OP = 'UPDATE' AND OLD.status IN ('open', 'active') AND OLD.locked_margin > 0 THEN
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (NEW.user_id, 'MARGIN_CREDIT', OLD.locked_margin, 'APPROVED', 'MRG_RET_' || NEW.id::text);
      NEW.locked_margin := OLD.locked_margin;
      NEW.margin_required := OLD.locked_margin;
    ELSIF TG_OP = 'UPDATE' THEN
      NEW.locked_margin := OLD.locked_margin;
      NEW.margin_required := OLD.margin_required;
    ELSE
      -- On INSERT of a closed position (e.g. partial exit split), keep the inserted values
      NEW.margin_required := COALESCE(NEW.margin_required, NEW.locked_margin, 0);
      NEW.locked_margin := COALESCE(NEW.locked_margin, NEW.margin_required, 0);
    END IF;
    RETURN NEW;
  END IF;

  SELECT trading_mode INTO v_trading_mode FROM public.profiles WHERE id = NEW.user_id;
  IF v_trading_mode = 'scalper' THEN v_settings_table := 'scalper_segment_settings'; ELSE v_settings_table := 'segment_settings'; END IF;

  IF v_settings_table = 'scalper_segment_settings' THEN
    SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.scalper_segment_settings WHERE user_id = NEW.user_id AND segment = NEW.settlement AND side = NEW.side;
  ELSE
    SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.segment_settings WHERE user_id = NEW.user_id AND segment = NEW.settlement AND side = NEW.side;
  END IF;

  IF v_leverage IS NULL THEN
    SELECT parent_id::uuid INTO v_parent_id FROM public.profiles WHERE id = NEW.user_id;
    IF v_parent_id IS NOT NULL THEN
      IF v_settings_table = 'scalper_segment_settings' THEN
        SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.scalper_segment_settings WHERE user_id = v_parent_id AND segment = NEW.settlement AND side = NEW.side;
      ELSE
        SELECT CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END, CASE WHEN NEW.product_type = 'CARRY' THEN holding_type ELSE intraday_type END INTO v_leverage, v_leverage_type FROM public.segment_settings WHERE user_id = v_parent_id AND segment = NEW.settlement AND side = NEW.side;
      END IF;
    END IF;
  END IF;

  IF v_leverage IS NULL OR v_leverage <= 0 THEN
    v_leverage_type := 'Multiplier';
    IF NEW.settlement LIKE '%FOREX%' OR NEW.settlement LIKE '%CDS%' THEN v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 10 ELSE 100 END; ELSIF NEW.settlement LIKE '%CRYPTO%' THEN v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 1 ELSE 10 END; ELSE v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 5 ELSE 50 END; END IF;
  END IF;

  IF v_leverage_type IS NULL OR v_leverage_type = '' THEN v_leverage_type := 'Multiplier'; END IF;

  IF v_leverage_type = '%' THEN
    v_computed_margin := (NEW.qty_open * NEW.entry_price) * (v_leverage / 100.0);
  ELSIF v_leverage_type = 'Fixed' THEN
    SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE NEW.symbol LIKE '%' || symbol || '%' ORDER BY length(symbol) DESC LIMIT 1;
    IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
      IF NEW.symbol LIKE '%BANKNIFTY%' OR NEW.symbol LIKE '%BANKEX%' THEN v_lot_size := 15; ELSIF NEW.symbol LIKE '%FINNIFTY%' THEN v_lot_size := 25; ELSIF NEW.symbol LIKE '%MIDCP%' OR NEW.symbol LIKE '%MIDCAP%' THEN v_lot_size := 50; ELSIF NEW.symbol LIKE '%SENSEX%' THEN v_lot_size := 10; ELSIF NEW.symbol LIKE '%NIFTY%' THEN v_lot_size := 25; ELSIF NEW.symbol LIKE '%GOLDM%' THEN v_lot_size := 10; ELSIF NEW.symbol LIKE '%GOLD%' THEN v_lot_size := 100; ELSIF NEW.symbol LIKE '%SILVERM%' THEN v_lot_size := 5; ELSIF NEW.symbol LIKE '%SILVER%' THEN v_lot_size := 30; ELSIF NEW.symbol LIKE '%CRUDEOILM%' THEN v_lot_size := 10; ELSIF NEW.symbol LIKE '%CRUDEOIL%' THEN v_lot_size := 100; ELSIF NEW.symbol LIKE '%NATGASMINI%' THEN v_lot_size := 250; ELSIF NEW.symbol LIKE '%NATURALGAS%' THEN v_lot_size := 1250; ELSE v_lot_size := 1; END IF;
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

-- Recreate trigger to avoid conflicts
DROP TRIGGER IF EXISTS positions_calculate_margin ON public.positions;

CREATE TRIGGER positions_calculate_margin
  BEFORE INSERT OR UPDATE OF status, qty_open, entry_price, product_type, settlement, side ON public.positions
  FOR EACH ROW EXECUTE PROCEDURE public.calculate_position_margin();


-- ------------------------------------------
-- FILE: 20260529_scalper_segment_settings.sql
-- ------------------------------------------
create table if not exists public.scalper_segment_settings (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references public.profiles(id) on delete cascade,
  segment             text        not null,
  side                text        not null check (side in ('BUY','SELL')),
  commission_type     text        not null default 'Per Crore',
  commission_value    numeric     not null default 4500,
  profit_hold_sec     integer     not null default 120,
  loss_hold_sec       integer     not null default 0,
  strike_range        numeric     not null default 0,
  max_lot             numeric     not null default 50,
  max_order_lot       numeric     not null default 50,
  intraday_leverage   numeric     not null default 50,
  intraday_type       text        not null default 'Multiplier',
  holding_leverage    numeric     not null default 5,
  entry_buffer        numeric     not null default 0.003,
  holding_type        text        not null default 'Multiplier',
  exit_buffer         numeric     not null default 0.0017,
  trade_allowed       boolean     not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (user_id, segment, side)
);

create index if not exists scalper_segment_settings_user_id_idx on public.scalper_segment_settings(user_id);

alter table public.scalper_segment_settings enable row level security;

create policy "Service role manages all scalper_segment_settings"
  on public.scalper_segment_settings for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- ------------------------------------------
-- FILE: 20260530_user_trading_mode.sql
-- ------------------------------------------
-- Add trading_mode and mode_locked_until columns to public.profiles table
alter table public.profiles
  add column if not exists trading_mode text not null default 'normal' check (trading_mode in ('normal', 'scalper')),
  add column if not exists mode_locked_until timestamptz default null;

-- Re-create calculate_position_margin to dynamically query settings from
-- the correct table (scalper_segment_settings vs segment_settings) based on active mode
CREATE OR REPLACE FUNCTION public.calculate_position_margin()
RETURNS trigger AS $$
DECLARE
  v_leverage numeric;
  v_parent_id uuid;
  v_trading_mode text;
BEGIN
  -- If position is closed or qty_open is 0, margin required is 0
  IF NEW.status = 'closed' OR NEW.qty_open = 0 THEN
    NEW.margin_required := 0;
  ELSE
    -- 1. Fetch user's active trading mode (default to normal if not found)
    SELECT trading_mode INTO v_trading_mode FROM public.profiles WHERE id = NEW.user_id;
    IF v_trading_mode IS NULL THEN
      v_trading_mode := 'normal';
    END IF;

    -- 2. Try to query the user's specific segment settings
    IF v_trading_mode = 'scalper' THEN
      SELECT 
        CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END INTO v_leverage
      FROM public.scalper_segment_settings
      WHERE user_id = NEW.user_id AND segment = NEW.settlement AND side = NEW.side;
    ELSE
      SELECT 
        CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END INTO v_leverage
      FROM public.segment_settings
      WHERE user_id = NEW.user_id AND segment = NEW.settlement AND side = NEW.side;
    END IF;

    -- 3. Fallback to parent broker's settings if not found
    IF v_leverage IS NULL THEN
      SELECT parent_id::uuid INTO v_parent_id FROM public.profiles WHERE id = NEW.user_id;
      IF v_parent_id IS NOT NULL THEN
        -- Query parent settings based on user's active mode
        IF v_trading_mode = 'scalper' THEN
          SELECT 
            CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END INTO v_leverage
          FROM public.scalper_segment_settings
          WHERE user_id = v_parent_id AND segment = NEW.settlement AND side = NEW.side;
        ELSE
          SELECT 
            CASE WHEN NEW.product_type = 'CARRY' THEN holding_leverage ELSE intraday_leverage END INTO v_leverage
          FROM public.segment_settings
          WHERE user_id = v_parent_id AND segment = NEW.settlement AND side = NEW.side;
        END IF;
      END IF;
    END IF;

    -- 4. Fallback to system defaults if still not found
    IF v_leverage IS NULL OR v_leverage <= 0 THEN
      IF NEW.settlement LIKE '%FOREX%' OR NEW.settlement LIKE '%CDS%' THEN
        v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 10 ELSE 100 END;
      ELSIF NEW.settlement LIKE '%CRYPTO%' THEN
        v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 1 ELSE 10 END;
      ELSE
        v_leverage := CASE WHEN NEW.product_type = 'CARRY' THEN 5 ELSE 50 END;
      END IF;
    END IF;

    -- 5. Calculate margin_required
    NEW.margin_required := (NEW.qty_open * NEW.entry_price) / v_leverage;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ------------------------------------------
-- FILE: 20260531_enable_realtime_market_quotes.sql
-- ------------------------------------------
-- Enable replica identity on market_quotes to get full payloads in realtime events
ALTER TABLE public.market_quotes REPLICA IDENTITY FULL;

-- Add the table to the supabase_realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'market_quotes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.market_quotes;
  END IF;
END $$;


-- ------------------------------------------
-- FILE: 20260532_allow_anon_read_market_quotes.sql
-- ------------------------------------------
-- Drop old select policies that only allowed authenticated users
DROP POLICY IF EXISTS "Allow authenticated users to read instruments" ON public.instruments;
DROP POLICY IF EXISTS "Allow authenticated users to read market_quotes" ON public.market_quotes;

-- Create new policies allowing both authenticated and anonymous users to select
CREATE POLICY "Allow read access to instruments for all" 
  ON public.instruments FOR SELECT USING (true);

CREATE POLICY "Allow read access to market_quotes for all" 
  ON public.market_quotes FOR SELECT USING (true);


-- ------------------------------------------
-- FILE: 20260533_position_validation.sql
-- ------------------------------------------
-- ─── 20260533_position_validation.sql ───
-- Add is_exit to orders
ALTER TABLE public.orders 
  ADD COLUMN IF NOT EXISTS is_exit boolean NOT NULL DEFAULT false;

-- Drop and recreate place_order to support p_is_exit
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_is_exit        boolean DEFAULT FALSE
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
BEGIN
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target, is_exit
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target, p_is_exit
  )
  RETURNING id INTO v_order_id;

  -- 2. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;

-- Redefine grants
REVOKE ALL ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean) TO service_role;


-- ─── Helper function to parse option symbol ───
CREATE OR REPLACE FUNCTION public.parse_option_symbol(p_symbol text, OUT o_underlying text, OUT o_strike numeric, OUT o_option_type text)
AS $$
DECLARE
  v_clean text;
  v_match text[];
BEGIN
  -- Strip exchange prefix if present, e.g. "NFO:NIFTY2652826500CE" -> "NIFTY2652826500CE"
  IF position(':' in p_symbol) > 0 THEN
    v_clean := substring(p_symbol from position(':' in p_symbol) + 1);
  ELSE
    v_clean := p_symbol;
  END IF;
  v_clean := upper(trim(v_clean));
  
  -- Regex: ^([A-Z]+)(\d{2}[A-Z0-9]{3})(\d+(?:\.\d+)?)(CE|PE)$
  v_match := regexp_matches(v_clean, '^([A-Z]+)(\d{2}[A-Z0-9]{3})(\d+(?:\.\d+)?)(CE|PE)$');
  
  IF v_match IS NOT NULL AND array_length(v_match, 1) = 4 THEN
    o_underlying := v_match[1];
    o_strike := v_match[3]::numeric;
    o_option_type := v_match[4];
  ELSE
    o_underlying := NULL;
    o_strike := NULL;
    o_option_type := NULL;
  END IF;
EXCEPTION WHEN OTHERS THEN
  o_underlying := NULL;
  o_strike := NULL;
  o_option_type := NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ─── Trigger Function to Handle Order Execution ───
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
BEGIN
  -- Only run for status = 'EXECUTED'
  IF NEW.status != 'EXECUTED' THEN
    RETURN NEW;
  END IF;

  -- Try parsing option details
  SELECT o_underlying, o_strike, o_option_type 
  INTO v_opt_underlying, v_opt_strike, v_opt_type
  FROM public.parse_option_symbol(NEW.symbol);

  IF v_opt_underlying IS NOT NULL AND v_opt_strike IS NOT NULL AND v_opt_type IS NOT NULL THEN
    v_is_option := true;
  END IF;

  IF v_is_option AND NEW.is_exit THEN
    v_remaining_qty := NEW.qty;
    
    -- Loop through open positions on the opposite side, matching by option key!
    FOR v_pos IN 
      SELECT p.*, opt.o_underlying, opt.o_strike, opt.o_option_type
      FROM public.positions p
      CROSS JOIN LATERAL public.parse_option_symbol(p.symbol) opt
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

        -- 1. Reduce the original position's qty_open and qty_total
        UPDATE public.positions
        SET 
          qty_open = qty_open - v_closed_qty,
          qty_total = qty_total - v_closed_qty,
          updated_at = now()
        WHERE id = v_pos.id;

        -- Calculate realized P&L for this closed part
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
          entry_time, exit_time, duration_seconds
        )
        VALUES (
          NEW.user_id, v_pos.symbol, v_pos.side, 'closed',
          v_closed_qty, 0,
          v_pos.entry_price, v_pos.entry_price, NEW.fill_price, NEW.ltp_at_entry,
          v_pnl, v_pos.settlement, v_pos.product_type, v_pos.stop_loss, v_pos.target,
          v_pos.entry_time, now(), EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer
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
        IF v_pos.side = 'BUY' THEN
          v_pnl := (NEW.fill_price - v_pos.entry_price) * v_closed_qty;
        ELSE
          v_pnl := (v_pos.entry_price - NEW.fill_price) * v_closed_qty;
        END IF;

        -- 1. Close the position
        UPDATE public.positions
        SET
          status = 'closed',
          qty_open = 0,
          exit_price = NEW.fill_price,
          exit_time = now(),
          pnl = v_pnl,
          ltp = NEW.ltp_at_entry,
          duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
          updated_at = now()
        WHERE id = v_pos.id;

        -- 2. Insert transaction
        v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (NEW.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

        v_remaining_qty := v_remaining_qty - v_closed_qty;
      END IF;
    END LOOP;

  ELSE
    -- NEW POSITION / ADD TO POSITION (or non-option, or normal entry)
    INSERT INTO public.positions (
      user_id, symbol, side, status,
      qty_total, qty_open,
      avg_price, entry_price, ltp,
      settlement, product_type, stop_loss, target
    )
    VALUES (
      NEW.user_id, NEW.symbol, NEW.side, 'open',
      NEW.qty, NEW.qty,
      NEW.fill_price, NEW.fill_price, NEW.ltp_at_entry,
      NEW.segment, NEW.product_type, NEW.stop_loss, NEW.target
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ─── Triggers ───
DROP TRIGGER IF EXISTS trg_order_executed_insert ON public.orders;
CREATE TRIGGER trg_order_executed_insert
  AFTER INSERT ON public.orders
  FOR EACH ROW
  WHEN (NEW.status = 'EXECUTED')
  EXECUTE FUNCTION public.handle_order_execution();

DROP TRIGGER IF EXISTS trg_order_executed_update ON public.orders;
CREATE TRIGGER trg_order_executed_update
  AFTER UPDATE ON public.orders
  FOR EACH ROW
  WHEN (NEW.status = 'EXECUTED' AND OLD.status != 'EXECUTED')
  EXECUTE FUNCTION public.handle_order_execution();


-- ------------------------------------------
-- FILE: 20260533_strict_position_validation.sql
-- ------------------------------------------
-- ─── 1. Add is_exit column to orders table ───
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_exit boolean DEFAULT false;

-- ─── 2. Create parse_option_symbol utility function ───
DROP FUNCTION IF EXISTS public.parse_option_symbol(text);
CREATE OR REPLACE FUNCTION public.parse_option_symbol(
  p_symbol text,
  OUT o_strike numeric,
  OUT o_option_type text,
  OUT o_underlying text
)
AS $$
DECLARE
  v_upper text;
BEGIN
  v_upper := upper(p_symbol);
  
  -- Parse strike and option type
  IF v_upper ~ '(\d+(?:\.\d+)?)(CE|PE)$' THEN
    o_strike := (substring(v_upper from '(\d+(?:\.\d+)?)(?:CE|PE)$'))::numeric;
    o_option_type := substring(v_upper from '(?:CE|PE)$');
  ELSE
    o_strike := NULL;
    o_option_type := NULL;
  END IF;

  -- Parse underlying symbol
  IF v_upper LIKE 'BANKNIFTY%' THEN o_underlying := 'BANKNIFTY';
  ELSIF v_upper LIKE 'FINNIFTY%' THEN o_underlying := 'FINNIFTY';
  ELSIF v_upper LIKE 'MIDCPNIFTY%' THEN o_underlying := 'MIDCPNIFTY';
  ELSIF v_upper LIKE 'NIFTY%' THEN o_underlying := 'NIFTY';
  ELSIF v_upper LIKE 'BANKEX%' THEN o_underlying := 'BANKEX';
  ELSIF v_upper LIKE 'SENSEX%' THEN o_underlying := 'SENSEX';
  ELSIF v_upper LIKE 'CRUDEOIL%' THEN o_underlying := 'CRUDEOIL';
  ELSIF v_upper LIKE 'GOLD%' THEN o_underlying := 'GOLD';
  ELSIF v_upper LIKE 'SILVER%' THEN o_underlying := 'SILVER';
  ELSIF v_upper LIKE 'NATURALGAS%' THEN o_underlying := 'NATURALGAS';
  ELSE o_underlying := NULL;
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;


-- ─── 3. Create process_executed_position helper ───
-- Handles position creation, accumulation, and partial/full exit split logic atomically.
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $
DECLARE
  v_order record;
  v_pos record;
  v_closed_pos_id uuid;
  v_pnl numeric;
  v_pnl_type text;
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_carry_comm_type text;
  v_carry_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_carry_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_carry_comm_type IS NULL THEN
    v_carry_comm_type := 'Per Crore';
    v_carry_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Fetch lot size dynamically if needed via ILIKE substring matching
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' LIMIT 1;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  -- 1. Standard Commission (INTRADAY / non-CARRY, non-GTT orders use main commission)
  IF v_order.product_type = 'CARRY' THEN
    -- Use carry-specific commission rate
    IF v_carry_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_carry_comm_val) / 10000000;
    ELSIF v_carry_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_carry_comm_val;
    ELSIF v_carry_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_carry_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  ELSE
    -- Use standard commission rate for INTRADAY orders
    IF v_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
    ELSIF v_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_comm_val;
    ELSIF v_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  END IF;

  -- 2. GTT Commission (only if GTT order, stacked on top)
  IF v_order.order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (v_order.qty * v_order.fill_price * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := v_raw_brokerage + v_gtt_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Debit buffer fee
  IF v_order.buffer_fee > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$;


-- ─── 4. Redefine place_order with strict options validations ───
-- Drop the old 15-parameter function first
DROP FUNCTION IF EXISTS public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric);

CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_is_exit        boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
  v_ord_strike numeric;
  v_ord_opt_type text;
  v_pos record;
  v_pos_strike numeric;
  v_pos_opt_type text;
BEGIN
  -- ─── STRICT OPTIONS DIRECTION AND QUANTITY VALIDATION ───
  SELECT * INTO v_ord_strike, v_ord_opt_type FROM public.parse_option_symbol(p_symbol);

  IF v_ord_strike IS NOT NULL AND v_ord_opt_type IS NOT NULL THEN
    -- Symbol is an options contract. Find active positions for the same contract
    FOR v_pos IN 
      SELECT * FROM public.positions 
      WHERE user_id = p_user_id AND status = 'open' AND qty_open > 0
    LOOP
      SELECT * INTO v_pos_strike, v_pos_opt_type FROM public.parse_option_symbol(v_pos.symbol);
      
      IF v_pos_strike = v_ord_strike AND v_pos_opt_type = v_ord_opt_type THEN
        -- Matching strike & option type found!
        
        IF p_is_exit THEN
          -- Exit validation
          IF v_pos.side = p_side THEN
            RAISE EXCEPTION 'No % position exists to exit', CASE WHEN v_pos.side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
          END IF;
          
          IF p_qty > v_pos.qty_open THEN
            RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
          END IF;
        
        ELSE
          -- Entry validation (Strict opposite block)
          IF v_pos.side != p_side THEN
            IF v_pos.side = 'BUY' THEN
              RAISE EXCEPTION 'Cannot open SELL position while BUY position is active';
            ELSE
              RAISE EXCEPTION 'Cannot open BUY position while SELL position is active';
            END IF;
          END IF;
        
        END IF;
        
      END IF;
    END LOOP;
    
    -- If it's explicitly marked as exit, but no active position was found:
    IF p_is_exit AND NOT FOUND THEN
      RAISE EXCEPTION 'No % position exists to exit', CASE WHEN p_side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
    END IF;
  END IF;

  -- ─── EXECUTE ORDER CREATION ───
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target, is_exit
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target, p_is_exit
  )
  RETURNING id INTO v_order_id;

  -- 2. Run positioning logic ONLY if EXECUTED immediately
  IF v_status = 'EXECUTED' THEN
    PERFORM public.process_executed_position(v_order_id);
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;


-- ─── 5. Re-grant permissions for place_order function ───
REVOKE ALL ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean) TO service_role;


-- ------------------------------------------
-- FILE: 20260601_fix_duplicate_trigger.sql
-- ------------------------------------------
-- This migration drops the old triggers that cause duplicate position quantities.
-- The RPC `place_order` now handles position updates directly via `process_executed_position`.
-- The trigger `handle_order_execution` runs redundantly, causing the quantity to be added twice.

DROP TRIGGER IF EXISTS trg_order_executed_insert ON public.orders;
DROP TRIGGER IF EXISTS trg_order_executed_update ON public.orders;

-- We can optionally drop the old function since it's no longer needed
-- DROP FUNCTION IF EXISTS public.handle_order_execution();


-- ------------------------------------------
-- FILE: 20260602_split_positions_by_product_type.sql
-- ------------------------------------------
-- ─── 1. Redefine process_executed_position helper ───
-- Handles position creation, accumulation, and partial/full exit split logic atomically by product_type.
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    -- Only process executed orders
    RETURN;
  END IF;

  -- Lock and fetch active position for this user, symbol, and product_type
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT FOUND THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- 1. Reduce quantity of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    IF FOUND THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        -- Defensive fallback — pre-execution validation should prevent this
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, stop_loss, target, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_order.side, 'open',
        v_order.qty, v_order.qty,
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, now(), now()
      );
    END IF;
  END IF;
END;
$$;

-- ─── 2. Redefine place_order with strict options validations by product_type ───
CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_is_exit        boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
  v_ord_strike numeric;
  v_ord_opt_type text;
  v_pos record;
  v_pos_strike numeric;
  v_pos_opt_type text;
BEGIN
  -- ─── STRICT OPTIONS DIRECTION AND QUANTITY VALIDATION ───
  SELECT * INTO v_ord_strike, v_ord_opt_type FROM public.parse_option_symbol(p_symbol);

  IF v_ord_strike IS NOT NULL AND v_ord_opt_type IS NOT NULL THEN
    -- Symbol is an options contract. Find active positions for the same contract and product_type
    FOR v_pos IN 
      SELECT * FROM public.positions 
      WHERE user_id = p_user_id AND status = 'open' AND qty_open > 0 AND product_type = p_product_type
    LOOP
      SELECT * INTO v_pos_strike, v_pos_opt_type FROM public.parse_option_symbol(v_pos.symbol);
      
      IF v_pos_strike = v_ord_strike AND v_pos_opt_type = v_ord_opt_type THEN
        -- Matching strike & option type found!
        
        IF p_is_exit THEN
          -- Exit validation
          IF v_pos.side = p_side THEN
            RAISE EXCEPTION 'No % position exists to exit', CASE WHEN v_pos.side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
          END IF;
          
          IF p_qty > v_pos.qty_open THEN
            RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
          END IF;
        
        ELSE
          -- Entry validation (Strict opposite block)
          IF v_pos.side != p_side THEN
            IF v_pos.side = 'BUY' THEN
              RAISE EXCEPTION 'Cannot open SELL position while BUY position is active';
            ELSE
              RAISE EXCEPTION 'Cannot open BUY position while SELL position is active';
            END IF;
          END IF;
        
        END IF;
        
      END IF;
    END LOOP;
    
    -- If it's explicitly marked as exit, but no active position was found:
    IF p_is_exit AND NOT FOUND THEN
      RAISE EXCEPTION 'No % position exists to exit', CASE WHEN p_side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
    END IF;
  END IF;

  -- ─── EXECUTE ORDER CREATION ───
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target, is_exit
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target, p_is_exit
  )
  RETURNING id INTO v_order_id;

  -- 2. Run positioning logic ONLY if EXECUTED immediately
  IF v_status = 'EXECUTED' THEN
    PERFORM public.process_executed_position(v_order_id);
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;

-- ─── 3. Redefine close_position to use the position's product_type for exit order ───
CREATE OR REPLACE FUNCTION public.close_position(
  p_position_id   uuid,
  p_user_id       uuid,
  p_ltp           numeric,
  p_exit_price    numeric,
  p_closed_by     text DEFAULT 'USER'
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pos          record;
  v_pnl          numeric;
  v_pnl_type     text;
  v_duration_sec integer;
BEGIN
  -- Fetch & lock the position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE id = p_position_id AND user_id = p_user_id AND status = 'open'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Position not found or already closed';
  END IF;

  -- Compute P&L
  IF v_pos.side = 'BUY' THEN
    v_pnl := (p_exit_price - v_pos.entry_price) * v_pos.qty_open;
  ELSE
    v_pnl := (v_pos.entry_price - p_exit_price) * v_pos.qty_open;
  END IF;

  -- Duration
  v_duration_sec := EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer;

  -- 1. Close the position
  UPDATE public.positions
  SET
    status           = 'closed',
    exit_price       = p_exit_price,
    exit_time        = now(),
    ltp              = p_ltp,
    pnl              = v_pnl,
    qty_open         = 0,
    duration_seconds = v_duration_sec,
    updated_at       = now()
  WHERE id = p_position_id;

  -- 2. Record exit order using the position's product_type
  INSERT INTO public.orders (
    user_id, symbol, segment, side, status,
    qty, price, fill_price, ltp_at_entry,
    order_type, product_type, info, is_exit
  )
  VALUES (
    p_user_id, v_pos.symbol, v_pos.settlement, 
    CASE WHEN v_pos.side = 'BUY' THEN 'SELL' ELSE 'BUY' END,
    'EXECUTED',
    v_pos.qty_open, p_exit_price, p_exit_price, p_ltp,
    'MARKET', v_pos.product_type,
    'Exit - ' || p_closed_by,
    true
  );

  -- 3. P&L settlement transaction
  v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;

  INSERT INTO public.transactions (
    user_id, type, amount, status, ref_id
  )
  VALUES (
    p_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED',
    p_position_id::text
  );

  -- 4. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN p_closed_by = 'AUTO_SQOFF' THEN 'AUTO_SQUARE_OFF' ELSE 'ORDER_EXECUTION' END,
    p_user_id, p_user_id,
    v_pos.symbol, v_pos.qty_open, p_exit_price,
    p_closed_by,
    p_exit_price,
    NULL,
    NULL,
    NULL,
    NULL,
    NULL
  );

  RETURN v_pnl;
END;
$$;

-- ─── 4. Re-grant permissions ───
REVOKE EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.close_position(uuid, uuid, numeric, numeric, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.close_position(uuid, uuid, numeric, numeric, text) TO service_role;


-- ------------------------------------------
-- FILE: 20260603_charge_brokerage.sql
-- ------------------------------------------
-- 1. Add brokerage column to public.orders table
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS brokerage numeric NOT NULL DEFAULT 0;

-- 2. Update public.transactions type check constraint
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check CHECK (type IN ('DEPOSIT','WITHDRAWAL','PNL_CREDIT','PNL_DEBIT','BROKERAGE_DEBIT'));

-- 3. Redefine sync_profile_balance trigger function to support PNL_CREDIT and DEPOSIT as positive additions, and others as subtractions
CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.status = 'APPROVED') THEN
    UPDATE public.profiles
    SET balance = balance + (CASE WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT') THEN NEW.amount ELSE -NEW.amount END),
        updated_at = now()
    WHERE id = NEW.user_id;
  ELSIF (TG_OP = 'UPDATE') THEN
    -- If status changed to APPROVED
    IF (OLD.status <> 'APPROVED' AND NEW.status = 'APPROVED') THEN
      UPDATE public.profiles
      SET balance = balance + (CASE WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT') THEN NEW.amount ELSE -NEW.amount END),
          updated_at = now()
      WHERE id = NEW.user_id;
    -- If an APPROVED transaction is deleted
    ELSIF (OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED') THEN
      UPDATE public.profiles
      SET balance = balance - (CASE WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT') THEN OLD.amount ELSE -OLD.amount END),
          updated_at = now()
      WHERE id = OLD.user_id;
    END IF;
  ELSIF (TG_OP = 'DELETE' AND OLD.status = 'APPROVED') THEN
    UPDATE public.profiles
    SET balance = balance - (CASE WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT') THEN OLD.amount ELSE -OLD.amount END),
        updated_at = now()
    WHERE id = OLD.user_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Redefine process_executed_position to charge brokerage on entry and split on partial exits
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value INTO v_comm_type, v_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value INTO v_comm_type, v_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  -- Fetch lot size dynamically if needed
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE symbol = v_order.symbol;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  IF v_comm_type = 'Per Crore' THEN
    v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
  ELSIF v_comm_type = 'Per Lot' THEN
    v_raw_brokerage := v_lots * v_comm_val;
  ELSIF v_comm_type = 'Per Trade' THEN
    v_raw_brokerage := v_comm_val;
  ELSE
    v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
  END IF;

  v_brokerage := v_raw_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity and entry brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, v_closed_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, stop_loss, target, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_order.side, 'open',
        v_order.qty, v_order.qty,
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$$;


-- ------------------------------------------
-- FILE: 20260604_set_default_liquidation.sql
-- ------------------------------------------
-- Update all existing profiles to have auto_sqoff = 90
UPDATE profiles SET auto_sqoff = 90 WHERE auto_sqoff IS DISTINCT FROM 90;


-- ------------------------------------------
-- FILE: 20260605_fix_act_logs_constraint.sql
-- ------------------------------------------
-- Drop the existing constraint
ALTER TABLE public.act_logs DROP CONSTRAINT IF EXISTS act_logs_type_check;

-- Add updated constraint including ORDER_PLACED, PAY_APPROVE, PAY_REJECT, and PAY_DELETE
ALTER TABLE public.act_logs ADD CONSTRAINT act_logs_type_check 
  CHECK (type IN (
    'ORDER_EXECUTION',
    'AUTO_SQUARE_OFF',
    'ORDER_CANCEL',
    'LOGIN',
    'LOGOUT',
    'ORDER_PLACED',
    'PAY_APPROVE',
    'PAY_REJECT',
    'PAY_DELETE'
  ));


-- ------------------------------------------
-- FILE: 20260606_position_split_brokerage.sql
-- ------------------------------------------
-- 1. Add entry_brokerage and exit_brokerage columns to public.positions table
ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS entry_brokerage numeric NOT NULL DEFAULT 0;
ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS exit_brokerage numeric NOT NULL DEFAULT 0;

-- 2. Update process_executed_position function to handle split brokerage recording on positions
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value INTO v_comm_type, v_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value INTO v_comm_type, v_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  -- Fetch lot size dynamically if needed
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE symbol = v_order.symbol;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  IF v_comm_type = 'Per Crore' THEN
    v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
  ELSIF v_comm_type = 'Per Lot' THEN
    v_raw_brokerage := v_lots * v_comm_val;
  ELSIF v_comm_type = 'Per Trade' THEN
    v_raw_brokerage := v_comm_val;
  ELSE
    v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
  END IF;

  v_brokerage := v_raw_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$$;


-- ------------------------------------------
-- FILE: 20260607_negative_balance_settlement.sql
-- ------------------------------------------
-- Add settlement_amount column to profiles table
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS settlement_amount numeric NOT NULL DEFAULT 0;

-- Redefine sync_profile_balance trigger function to support capping balance at 0 and routing negative balances to settlement_amount
CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id uuid;
  v_change numeric := 0;
  v_current_bal numeric;
  v_current_settle numeric;
  v_new_val numeric;
BEGIN
  -- Determine user_id and change amount
  IF (TG_OP = 'INSERT' AND NEW.status = 'APPROVED') THEN
    v_user_id := NEW.user_id;
    v_change := (CASE WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT') THEN NEW.amount ELSE -NEW.amount END);
  ELSIF (TG_OP = 'UPDATE') THEN
    v_user_id := NEW.user_id;
    IF (OLD.status <> 'APPROVED' AND NEW.status = 'APPROVED') THEN
      v_change := (CASE WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT') THEN NEW.amount ELSE -NEW.amount END);
    ELSIF (OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED') THEN
      v_change := -(CASE WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT') THEN OLD.amount ELSE -OLD.amount END);
    END IF;
  ELSIF (TG_OP = 'DELETE' AND OLD.status = 'APPROVED') THEN
    v_user_id := OLD.user_id;
    v_change := -(CASE WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT') THEN OLD.amount ELSE -OLD.amount END);
  END IF;

  IF v_user_id IS NOT NULL AND v_change <> 0 THEN
    -- Lock and select current balance and settlement_amount
    SELECT COALESCE(balance, 0), COALESCE(settlement_amount, 0)
    INTO v_current_bal, v_current_settle
    FROM public.profiles
    WHERE id = v_user_id
    FOR UPDATE;

    IF FOUND THEN
      v_new_val := v_current_bal + v_change + v_current_settle;
      IF v_new_val < 0 THEN
        UPDATE public.profiles
        SET balance = 0,
            settlement_amount = v_new_val,
            updated_at = now()
        WHERE id = v_user_id;
      ELSE
        UPDATE public.profiles
        SET balance = v_new_val,
            settlement_amount = 0,
            updated_at = now()
        WHERE id = v_user_id;
      END IF;
    END IF;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- One-time sync/recalculation for all profiles
DO $$
DECLARE
  r record;
  v_total numeric;
BEGIN
  FOR r IN SELECT id FROM public.profiles LOOP
    SELECT COALESCE(SUM(CASE WHEN type IN ('DEPOSIT', 'PNL_CREDIT') THEN amount ELSE -amount END), 0)
    INTO v_total
    FROM public.transactions
    WHERE user_id = r.id AND status = 'APPROVED';

    IF v_total < 0 THEN
      UPDATE public.profiles
      SET balance = 0, settlement_amount = v_total
      WHERE id = r.id;
    ELSE
      UPDATE public.profiles
      SET balance = v_total, settlement_amount = 0
      WHERE id = r.id;
    END IF;
  END LOOP;
END;
$$;


-- ------------------------------------------
-- FILE: 20260608_segment_limits.sql
-- ------------------------------------------
-- Add top_limit and min_limit columns to segment_settings and scalper_segment_settings tables
ALTER TABLE public.segment_settings 
  ADD COLUMN IF NOT EXISTS top_limit numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_limit numeric NOT NULL DEFAULT 0;

ALTER TABLE public.scalper_segment_settings 
  ADD COLUMN IF NOT EXISTS top_limit numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS min_limit numeric NOT NULL DEFAULT 0;


-- ------------------------------------------
-- FILE: 20260609_script_settings_substring_match.sql
-- ------------------------------------------
-- Update process_executed_position function to handle substring matching for script settings lot size
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value INTO v_comm_type, v_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value INTO v_comm_type, v_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  -- Fetch lot size dynamically if needed via ILIKE substring matching
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' LIMIT 1;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  IF v_comm_type = 'Per Crore' THEN
    v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
  ELSIF v_comm_type = 'Per Lot' THEN
    v_raw_brokerage := v_lots * v_comm_val;
  ELSIF v_comm_type = 'Per Trade' THEN
    v_raw_brokerage := v_comm_val;
  ELSE
    v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
  END IF;

  v_brokerage := v_raw_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$$;


-- ------------------------------------------
-- FILE: 20260610_add_gtt_brokerage.sql
-- ------------------------------------------
-- Add GTT commission type and value to segment_settings
ALTER TABLE public.segment_settings ADD COLUMN IF NOT EXISTS gtt_commission_type text NOT NULL DEFAULT 'Per Trade';
ALTER TABLE public.segment_settings ADD COLUMN IF NOT EXISTS gtt_commission_value numeric NOT NULL DEFAULT 10;

-- Add GTT commission type and value to scalper_segment_settings
ALTER TABLE public.scalper_segment_settings ADD COLUMN IF NOT EXISTS gtt_commission_type text NOT NULL DEFAULT 'Per Trade';
ALTER TABLE public.scalper_segment_settings ADD COLUMN IF NOT EXISTS gtt_commission_value numeric NOT NULL DEFAULT 10;

-- Update process_executed_position function to handle GTT commission calculation on top of standard commission
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Fetch lot size dynamically if needed via ILIKE substring matching
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' LIMIT 1;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  -- 1. Standard Commission
  IF v_comm_type = 'Per Crore' THEN
    v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
  ELSIF v_comm_type = 'Per Lot' THEN
    v_raw_brokerage := v_lots * v_comm_val;
  ELSIF v_comm_type = 'Per Trade' THEN
    v_raw_brokerage := v_comm_val;
  ELSE
    v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
  END IF;

  -- 2. GTT Commission (only if GTT order)
  IF v_order.order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (v_order.qty * v_order.fill_price * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := v_raw_brokerage + v_gtt_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$$;


-- ------------------------------------------
-- FILE: 20260611_add_carry_brokerage.sql
-- ------------------------------------------
-- Add carry commission type and value to segment_settings
ALTER TABLE public.segment_settings ADD COLUMN IF NOT EXISTS carry_commission_type text NOT NULL DEFAULT 'Per Crore';
ALTER TABLE public.segment_settings ADD COLUMN IF NOT EXISTS carry_commission_value numeric NOT NULL DEFAULT 4500;

-- Add carry commission type and value to scalper_segment_settings
ALTER TABLE public.scalper_segment_settings ADD COLUMN IF NOT EXISTS carry_commission_type text NOT NULL DEFAULT 'Per Crore';
ALTER TABLE public.scalper_segment_settings ADD COLUMN IF NOT EXISTS carry_commission_value numeric NOT NULL DEFAULT 4500;

-- Update process_executed_position function to handle carry commission separately from standard commission
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_carry_comm_type text;
  v_carry_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_carry_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_carry_comm_type IS NULL THEN
    v_carry_comm_type := 'Per Crore';
    v_carry_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Fetch lot size dynamically if needed via ILIKE substring matching
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' LIMIT 1;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  -- 1. Standard Commission (INTRADAY / non-CARRY, non-GTT orders use main commission)
  IF v_order.product_type = 'CARRY' THEN
    -- Use carry-specific commission rate
    IF v_carry_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_carry_comm_val) / 10000000;
    ELSIF v_carry_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_carry_comm_val;
    ELSIF v_carry_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_carry_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  ELSE
    -- Use standard commission rate for INTRADAY orders
    IF v_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
    ELSIF v_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_comm_val;
    ELSIF v_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  END IF;

  -- 2. GTT Commission (only if GTT order, stacked on top)
  IF v_order.order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (v_order.qty * v_order.fill_price * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := v_raw_brokerage + v_gtt_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$$;


-- ------------------------------------------
-- FILE: 20260612_add_position_log_types.sql
-- ------------------------------------------
-- Add POSITION_EDIT and POSITION_DELETE to the act_logs check constraint
ALTER TABLE public.act_logs DROP CONSTRAINT IF EXISTS act_logs_type_check;

ALTER TABLE public.act_logs ADD CONSTRAINT act_logs_type_check 
  CHECK (type IN (
    'ORDER_EXECUTION',
    'AUTO_SQUARE_OFF',
    'ORDER_CANCEL',
    'LOGIN',
    'LOGOUT',
    'ORDER_PLACED',
    'PAY_APPROVE',
    'PAY_REJECT',
    'PAY_DELETE',
    'POSITION_EDIT',
    'POSITION_DELETE'
  ));


-- ------------------------------------------
-- FILE: 20260613_historical_candles_and_realtime_disable.sql
-- ------------------------------------------
-- Disable Realtime on market_quotes to stop triggering Supabase Realtime egress
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' 
    AND schemaname = 'public' 
    AND tablename = 'market_quotes'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.market_quotes;
  END IF;
END $$;

-- Create historical_candles table for OHLCV data
CREATE TABLE IF NOT EXISTS public.historical_candles (
  symbol text not null,
  timestamp timestamptz not null,
  interval text not null, -- '1m', '5m', '15m', '1h'
  open numeric not null,
  high numeric not null,
  low numeric not null,
  close numeric not null,
  volume bigint not null,
  primary key (symbol, timestamp, interval)
);

-- Enable RLS on historical_candles
ALTER TABLE public.historical_candles ENABLE ROW LEVEL SECURITY;

-- Allow read access to historical_candles for all authenticated users
CREATE POLICY "Allow read access to historical_candles for all" 
  ON public.historical_candles FOR SELECT USING (true);


-- ------------------------------------------
-- FILE: 20260614_add_buffer_fee.sql
-- ------------------------------------------

-- 1. Add buffer_fee column to public.orders table
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buffer_fee numeric NOT NULL DEFAULT 0;

-- 2. Update public.transactions type check constraint to include BUFFER_FEE_DEBIT
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check 
  CHECK (type IN ('DEPOSIT','WITHDRAWAL','PNL_CREDIT','PNL_DEBIT','BROKERAGE_DEBIT','BUFFER_FEE_DEBIT'));

-- 3. Redefine place_order to accept and insert p_buffer_fee
CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_is_exit        boolean DEFAULT false,
  p_buffer_fee     numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
  v_ord_strike numeric;
  v_ord_opt_type text;
  v_pos record;
  v_pos_strike numeric;
  v_pos_opt_type text;
BEGIN
  -- ─── STRICT OPTIONS DIRECTION AND QUANTITY VALIDATION ───
  SELECT * INTO v_ord_strike, v_ord_opt_type FROM public.parse_option_symbol(p_symbol);

  IF v_ord_strike IS NOT NULL AND v_ord_opt_type IS NOT NULL THEN
    -- Symbol is an options contract. Find active positions for the same contract and product_type
    FOR v_pos IN 
      SELECT * FROM public.positions 
      WHERE user_id = p_user_id AND status = 'open' AND qty_open > 0 AND product_type = p_product_type
    LOOP
      SELECT * INTO v_pos_strike, v_pos_opt_type FROM public.parse_option_symbol(v_pos.symbol);
      
      IF v_pos_strike = v_ord_strike AND v_pos_opt_type = v_ord_opt_type THEN
        -- Matching strike & option type found!
        
        IF p_is_exit THEN
          -- Exit validation
          IF v_pos.side = p_side THEN
            RAISE EXCEPTION 'No % position exists to exit', CASE WHEN v_pos.side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
          END IF;
          
          IF p_qty > v_pos.qty_open THEN
            RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
          END IF;
        
        ELSE
          -- Entry validation (Strict opposite block)
          IF v_pos.side != p_side THEN
            IF v_pos.side = 'BUY' THEN
              RAISE EXCEPTION 'Cannot open SELL position while BUY position is active';
            ELSE
              RAISE EXCEPTION 'Cannot open BUY position while SELL position is active';
            END IF;
          END IF;
        
        END IF;
        
      END IF;
    END LOOP;
    
    -- If it's explicitly marked as exit, but no active position was found:
    IF p_is_exit AND NOT FOUND THEN
      RAISE EXCEPTION 'No % position exists to exit', CASE WHEN p_side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
    END IF;
  END IF;

  -- ─── EXECUTE ORDER CREATION ───
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target, is_exit, buffer_fee
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target, p_is_exit, p_buffer_fee
  )
  RETURNING id INTO v_order_id;

  -- 2. Run positioning logic ONLY if EXECUTED immediately
  IF v_status = 'EXECUTED' THEN
    PERFORM public.process_executed_position(v_order_id);
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason,
    original_price, margin_used, buffer, brokerage_value, brokerage_mode, trade_mode
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger'),
    CASE WHEN v_status = 'EXECUTED' THEN p_fill_price ELSE NULL END,
    NULL,
    NULL,
    NULL,
    NULL,
    CASE WHEN v_status = 'EXECUTED' THEN lower(p_product_type) ELSE NULL END
  );

  RETURN v_order_id;
END;
$$;

-- 4. Redefine process_executed_position to debit buffer_fee and fix segment settings and status active
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_carry_comm_type text;
  v_carry_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_carry_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_closed_margin numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_carry_comm_type IS NULL THEN
    v_carry_comm_type := 'Per Crore';
    v_carry_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Fetch lot size dynamically if needed via ILIKE substring matching
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' LIMIT 1;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol LIKE '%BANKNIFTY%' OR v_order.symbol LIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol LIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol LIKE '%MIDCP%' OR v_order.symbol LIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol LIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol LIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  -- 1. Standard Commission (INTRADAY / non-CARRY, non-GTT orders use main commission)
  IF v_order.product_type = 'CARRY' THEN
    -- Use carry-specific commission rate
    IF v_carry_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_carry_comm_val) / 10000000;
    ELSIF v_carry_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_carry_comm_val;
    ELSIF v_carry_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_carry_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  ELSE
    -- Use standard commission rate for INTRADAY orders
    IF v_comm_type = 'Per Crore' THEN
      v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
    ELSIF v_comm_type = 'Per Lot' THEN
      v_raw_brokerage := v_lots * v_comm_val;
    ELSIF v_comm_type = 'Per Trade' THEN
      v_raw_brokerage := v_comm_val;
    ELSE
      v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  END IF;

  -- 2. GTT Commission (only if GTT order, stacked on top)
  IF v_order.order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (v_order.qty * v_order.fill_price * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := v_raw_brokerage + v_gtt_brokerage;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Debit buffer fee
  IF COALESCE(v_order.buffer_fee, 0) > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status IN ('open', 'active') 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction only if it's non-zero
      IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);
      END IF;

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage and margin for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_margin := (v_pos.locked_margin * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at,
        locked_margin, margin_required
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now(),
        v_closed_margin, v_closed_margin
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion only if it's non-zero
      IF v_pnl <> 0 THEN
        v_pnl_type := CASE WHEN v_pnl > 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
        INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
        VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);
      END IF;

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;
END;
$$;
-- 5. Re-grant permissions
REVOKE EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean, numeric) TO service_role;
-- ==========================================
-- FILE: 20260628_referral_update.sql
-- DESCRIPTION: Schema updates for new referral logic (First Trade Bonus & Weekly Brokerage)
-- ==========================================

-- 1. Track if a user has started trading
ALTER TABLE public.profiles 
  ADD COLUMN IF NOT EXISTS has_traded BOOLEAN NOT NULL DEFAULT FALSE;

-- 2. Add an earning_type to referral_earnings to distinguish bonuses
ALTER TABLE public.referral_earnings
  ADD COLUMN IF NOT EXISTS earning_type TEXT DEFAULT 'DEPOSIT_COMMISSION';

-- 3. Track which brokerage transactions have been paid out to referrers
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS brokerage_shared BOOLEAN NOT NULL DEFAULT FALSE;
CREATE OR REPLACE FUNCTION public.sync_profile_balance()
RETURNS TRIGGER AS $$
DECLARE
  v_user_id       uuid;
  v_change        numeric := 0;
  v_current_bal   numeric;
  v_new_bal       numeric;
BEGIN
  -- Skip margin transactions so they don't affect profiles.balance
  IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
    IF NEW.type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN
      RETURN NEW;
    END IF;
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.type IN ('MARGIN_DEBIT', 'MARGIN_CREDIT') THEN
      RETURN OLD;
    END IF;
  END IF;

  IF (TG_OP = 'INSERT' AND NEW.status = 'APPROVED') THEN
    v_user_id := NEW.user_id;
    v_change  := CASE
                   WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT')
                   THEN  NEW.amount
                   ELSE -NEW.amount
                 END;
  ELSIF (TG_OP = 'UPDATE') THEN
    v_user_id := NEW.user_id;
    IF OLD.status <> 'APPROVED' AND NEW.status = 'APPROVED' THEN
      v_change := CASE
                    WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT')
                    THEN  NEW.amount
                    ELSE -NEW.amount
                  END;
    ELSIF OLD.status = 'APPROVED' AND NEW.status <> 'APPROVED' THEN
      v_change := -( CASE
                       WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT')
                       THEN  OLD.amount
                       ELSE -OLD.amount
                     END );
    ELSIF OLD.status = 'APPROVED' AND NEW.status = 'APPROVED' THEN
      v_change := (CASE
                     WHEN NEW.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT')
                     THEN  NEW.amount
                     ELSE -NEW.amount
                   END) - (CASE
                             WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT')
                             THEN  OLD.amount
                             ELSE -OLD.amount
                           END);
    END IF;

  ELSIF (TG_OP = 'DELETE' AND OLD.status = 'APPROVED') THEN
    v_user_id := OLD.user_id;
    v_change  := -( CASE
                      WHEN OLD.type IN ('DEPOSIT', 'PNL_CREDIT', 'MARGIN_ADJ_CREDIT')
                      THEN  OLD.amount
                      ELSE -OLD.amount
                    END );
  END IF;

  IF v_user_id IS NULL OR v_change = 0 THEN
    RETURN NULL;
  END IF;

  SELECT COALESCE(balance, 0)
    INTO v_current_bal
    FROM public.profiles
   WHERE id = v_user_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_new_bal := v_current_bal + v_change;

  IF v_new_bal >= 0 THEN
    UPDATE public.profiles
       SET balance    = v_new_bal,
           updated_at = now()
      WHERE id = v_user_id;
  ELSE
    UPDATE public.profiles
       SET balance          = 0,
           settlement_amount = COALESCE(settlement_amount, 0) + v_new_bal,
           updated_at        = now()
      WHERE id = v_user_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
-- ------------------------------------------
-- FILE: 20260614_add_buffer_fee.sql
-- ------------------------------------------

-- 1. Add buffer_fee column to public.orders table
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS buffer_fee numeric NOT NULL DEFAULT 0;

-- 2. Update public.transactions type check constraint to include BUFFER_FEE_DEBIT
ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_type_check 
  CHECK (type IN ('DEPOSIT','WITHDRAWAL','PNL_CREDIT','PNL_DEBIT','BROKERAGE_DEBIT','BUFFER_FEE_DEBIT'));

-- 3. Redefine place_order to accept and insert p_buffer_fee
CREATE OR REPLACE FUNCTION public.place_order(
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
  p_info           text DEFAULT NULL,
  p_trigger_price  numeric DEFAULT NULL,
  p_stop_loss      numeric DEFAULT NULL,
  p_target         numeric DEFAULT NULL,
  p_is_exit        boolean DEFAULT false,
  p_buffer_fee     numeric DEFAULT 0
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_order_id uuid;
  v_status   text;
  v_ord_strike numeric;
  v_ord_opt_type text;
  v_pos record;
  v_pos_strike numeric;
  v_pos_opt_type text;
BEGIN
  -- ─── STRICT OPTIONS DIRECTION AND QUANTITY VALIDATION ───
  SELECT * INTO v_ord_strike, v_ord_opt_type FROM public.parse_option_symbol(p_symbol);

  IF v_ord_strike IS NOT NULL AND v_ord_opt_type IS NOT NULL THEN
    -- Symbol is an options contract. Find active positions for the same contract and product_type
    FOR v_pos IN 
      SELECT * FROM public.positions 
      WHERE user_id = p_user_id AND status = 'open' AND qty_open > 0 AND product_type = p_product_type
    LOOP
      SELECT * INTO v_pos_strike, v_pos_opt_type FROM public.parse_option_symbol(v_pos.symbol);
      
      IF v_pos_strike = v_ord_strike AND v_pos_opt_type = v_ord_opt_type THEN
        -- Matching strike & option type found!
        
        IF p_is_exit THEN
          -- Exit validation
          IF v_pos.side = p_side THEN
            RAISE EXCEPTION 'No % position exists to exit', CASE WHEN v_pos.side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
          END IF;
          
          IF p_qty > v_pos.qty_open THEN
            RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
          END IF;
        
        ELSE
          -- Entry validation (Strict opposite block)
          IF v_pos.side != p_side THEN
            IF v_pos.side = 'BUY' THEN
              RAISE EXCEPTION 'Cannot open SELL position while BUY position is active';
            ELSE
              RAISE EXCEPTION 'Cannot open BUY position while SELL position is active';
            END IF;
          END IF;
        
        END IF;
        
      END IF;
    END LOOP;
    
    -- If it's explicitly marked as exit, but no active position was found:
    IF p_is_exit AND NOT FOUND THEN
      RAISE EXCEPTION 'No % position exists to exit', CASE WHEN p_side = 'BUY' THEN 'SELL' ELSE 'BUY' END;
    END IF;
  END IF;

  -- ─── EXECUTE ORDER CREATION ───
  -- Determine status: MARKET/SLM execute immediately, LIMIT/SL/GTT are PENDING
  IF p_order_type IN ('MARKET', 'SLM') THEN
    v_status := 'EXECUTED';
  ELSE
    v_status := 'PENDING';
  END IF;

  -- 1. Insert order record
  INSERT INTO public.orders (
    user_id, symbol, kite_instrument, segment,
    side, status, qty, lots,
    price, fill_price, ltp_at_entry,
    order_type, product_type, info,
    trigger_price, stop_loss, target, is_exit, buffer_fee
  )
  VALUES (
    p_user_id, p_symbol, p_kite_inst, p_segment,
    p_side, v_status, p_qty, p_lots,
    p_fill_price, p_fill_price, p_ltp,
    p_order_type, p_product_type, p_info,
    p_trigger_price, p_stop_loss, p_target, p_is_exit, p_buffer_fee
  )
  RETURNING id INTO v_order_id;

  -- 2. Run positioning logic ONLY if EXECUTED immediately
  IF v_status = 'EXECUTED' THEN
    PERFORM public.process_executed_position(v_order_id);
  END IF;

  -- 3. Audit log
  INSERT INTO public.act_logs (
    type, user_id, target_user_id, symbol, qty, price, reason
  )
  VALUES (
    CASE WHEN v_status = 'EXECUTED' THEN 'ORDER_EXECUTION' ELSE 'ORDER_PLACED' END,
    p_user_id, p_user_id,
    p_symbol, p_qty, p_fill_price,
    p_order_type || ' ' || v_status || ' @ ' || COALESCE(p_trigger_price::text, 'no-trigger')
  );

  RETURN v_order_id;
END;
$$;

-- 4. Redefine process_executed_position to debit buffer_fee
CREATE OR REPLACE FUNCTION public.process_executed_position(p_order_id uuid)
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
  v_new_avg_price numeric;
  
  -- Brokerage local vars
  v_trading_mode text;
  v_comm_type text;
  v_comm_val numeric;
  v_carry_comm_type text;
  v_carry_comm_val numeric;
  v_gtt_comm_type text;
  v_gtt_comm_val numeric;
  v_raw_brokerage numeric := 0;
  v_carry_brokerage numeric := 0;
  v_gtt_brokerage numeric := 0;
  v_brokerage numeric := 0;
  v_closed_brokerage numeric := 0;
  v_closed_entry_brokerage numeric := 0;
  v_pos_found boolean;
  v_lot_size numeric;
  v_lots numeric;
  
  -- Referral / First Trade Bonus vars
  v_has_traded boolean;
  v_parent_id_text text;
BEGIN
  -- Fetch the order
  SELECT * INTO v_order
  FROM public.orders
  WHERE id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Order % not found', p_order_id;
  END IF;

  IF v_order.status != 'EXECUTED' THEN
    RETURN;
  END IF;

  -- ─── CALCULATE & CHARGE BROKERAGE FOR THIS ORDER ───
  SELECT trading_mode INTO v_trading_mode
  FROM public.profiles
  WHERE id = v_order.user_id;

  IF v_trading_mode = 'scalper' THEN
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.scalper_segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  ELSE
    SELECT commission_type, commission_value, carry_commission_type, carry_commission_value, gtt_commission_type, gtt_commission_value 
    INTO v_comm_type, v_comm_val, v_carry_comm_type, v_carry_comm_val, v_gtt_comm_type, v_gtt_comm_val
    FROM public.segment_settings
    WHERE user_id = v_order.user_id AND segment = v_order.segment AND side = v_order.side;
  END IF;

  -- Defaults fallback
  IF v_comm_type IS NULL THEN
    v_comm_type := 'Per Crore';
    v_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_carry_comm_type IS NULL THEN
    v_carry_comm_type := 'Per Crore';
    v_carry_comm_val := CASE WHEN v_order.segment = 'FOREX' THEN 2000 WHEN v_order.segment = 'CRYPTO' THEN 1000 ELSE 4500 END;
  END IF;

  IF v_gtt_comm_type IS NULL THEN
    v_gtt_comm_type := 'Per Trade';
    v_gtt_comm_val := 10;
  END IF;

  -- Fetch lot size dynamically if needed via ILIKE substring matching
  SELECT lot_size INTO v_lot_size FROM public.script_settings WHERE v_order.symbol ILIKE '%' || symbol || '%' ORDER BY length(symbol) DESC LIMIT 1;
  IF v_lot_size IS NULL OR v_lot_size <= 0 THEN
    IF v_order.symbol ILIKE '%BANKNIFTY%' OR v_order.symbol ILIKE '%BANKEX%' THEN
      v_lot_size := 15;
    ELSIF v_order.symbol ILIKE '%FINNIFTY%' THEN
      v_lot_size := 40;
    ELSIF v_order.symbol ILIKE '%MIDCP%' OR v_order.symbol ILIKE '%MIDCAP%' THEN
      v_lot_size := 75;
    ELSIF v_order.symbol ILIKE '%SENSEX%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol ILIKE '%NIFTY%' THEN
      v_lot_size := 25;
    ELSIF v_order.symbol ILIKE '%GOLDM%' THEN
      v_lot_size := 10;
    ELSIF v_order.symbol ILIKE '%GOLD%' THEN
      v_lot_size := 100;
    ELSIF v_order.symbol ILIKE '%SILVERM%' THEN
      v_lot_size := 5;
    ELSIF v_order.symbol ILIKE '%SILVER%' THEN
      v_lot_size := 30;
    ELSIF v_order.symbol ILIKE '%CRUDEOIL%' THEN
      v_lot_size := 100;
    ELSIF v_order.symbol ILIKE '%NATURALGAS%' THEN
      v_lot_size := 1250;
    ELSE
      v_lot_size := 1;
    END IF;
  END IF;

  v_lots := COALESCE(NULLIF(v_order.lots, 0), v_order.qty / v_lot_size);

  -- 1. Intraday Commission (ALWAYS applied)
  IF v_comm_type = 'Per Crore' THEN
    v_raw_brokerage := (v_order.qty * v_order.fill_price * v_comm_val) / 10000000;
  ELSIF v_comm_type = 'Per Lot' THEN
    v_raw_brokerage := v_lots * v_comm_val;
  ELSIF v_comm_type = 'Per Trade' THEN
    v_raw_brokerage := v_comm_val;
  ELSE
    v_raw_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
  END IF;

  -- 2. Carry Commission (only if CARRY order, stacked on top)
  IF v_order.product_type = 'CARRY' THEN
    IF v_carry_comm_type = 'Per Crore' THEN
      v_carry_brokerage := (v_order.qty * v_order.fill_price * v_carry_comm_val) / 10000000;
    ELSIF v_carry_comm_type = 'Per Lot' THEN
      v_carry_brokerage := v_lots * v_carry_comm_val;
    ELSIF v_carry_comm_type = 'Per Trade' THEN
      v_carry_brokerage := v_carry_comm_val;
    ELSE
      v_carry_brokerage := (v_order.qty * v_order.fill_price * 0.001); -- 0.1% fallback
    END IF;
  END IF;

  -- 3. GTT Commission (only if GTT order, stacked on top)
  IF v_order.order_type = 'GTT' THEN
    IF v_gtt_comm_type = 'Per Crore' THEN
      v_gtt_brokerage := (v_order.qty * v_order.fill_price * v_gtt_comm_val) / 10000000;
    ELSIF v_gtt_comm_type = 'Per Lot' THEN
      v_gtt_brokerage := v_lots * v_gtt_comm_val;
    ELSIF v_gtt_comm_type = 'Per Trade' THEN
      v_gtt_brokerage := v_gtt_comm_val;
    ELSE
      v_gtt_brokerage := 0;
    END IF;
  END IF;

  v_brokerage := (v_raw_brokerage + v_carry_brokerage + v_gtt_brokerage) * 2;

  -- Save brokerage and lots to the order
  UPDATE public.orders
  SET brokerage = v_brokerage,
      lots = v_lots
  WHERE id = v_order.id;

  -- Debit user's balance immediately via transaction
  IF v_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BROKERAGE_DEBIT', v_brokerage, 'APPROVED', 'BKG_' || v_order.id::text);
  END IF;

  -- Debit buffer fee
  IF v_order.buffer_fee > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (v_order.user_id, 'BUFFER_FEE_DEBIT', v_order.buffer_fee, 'APPROVED', 'BUF_' || v_order.id::text);
  END IF;

  -- Lock and fetch active position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE user_id = v_order.user_id 
    AND symbol = v_order.symbol 
    AND status = 'open' 
    AND product_type = v_order.product_type
  FOR UPDATE;

  v_pos_found := FOUND;

  IF v_order.is_exit THEN
    -- ─── EXIT ORDER LOGIC ───
    IF NOT v_pos_found THEN
      RAISE EXCEPTION 'No active position exists to exit';
    END IF;

    IF v_pos.side = v_order.side THEN
      RAISE EXCEPTION 'Invalid exit side: exit order side must be opposite of position side';
    END IF;

    IF v_order.qty > v_pos.qty_open THEN
      RAISE EXCEPTION 'Exit quantity cannot exceed current position quantity';
    END IF;

    -- Calculate realized P&L (BUY = exit - entry, SELL = entry - exit)
    IF v_pos.side = 'BUY' THEN
      v_pnl := (v_order.fill_price - v_pos.entry_price) * v_order.qty;
    ELSE
      v_pnl := (v_pos.entry_price - v_order.fill_price) * v_order.qty;
    END IF;

    IF v_order.qty = v_pos.qty_open THEN
      -- FULL EXIT: Close active position row and add exit brokerage
      UPDATE public.positions
      SET
        status = 'closed',
        qty_open = 0,
        exit_price = v_order.fill_price,
        exit_time = now(),
        pnl = v_pnl,
        duration_seconds = EXTRACT(EPOCH FROM (now() - entry_time))::integer,
        exit_brokerage = exit_brokerage + v_brokerage,
        brokerage = brokerage + v_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- Record PNL transaction
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_pos.id::text);

    ELSE
      -- PARTIAL EXIT: Split position
      -- Calculate proportional entry brokerage for the closed portion
      v_closed_entry_brokerage := (v_pos.entry_brokerage * v_order.qty) / v_pos.qty_open;
      v_closed_brokerage := (v_pos.brokerage * v_order.qty) / v_pos.qty_open;

      -- 1. Reduce quantity, entry brokerage and total brokerage of the active open position
      UPDATE public.positions
      SET
        qty_open = qty_open - v_order.qty,
        qty_total = qty_total - v_order.qty,
        entry_brokerage = entry_brokerage - v_closed_entry_brokerage,
        brokerage = brokerage - v_closed_brokerage,
        updated_at = now()
      WHERE id = v_pos.id;

      -- 2. Create a new CLOSED position representing the exited portion (entry share + exit brokerage)
      INSERT INTO public.positions (
        user_id, symbol, side, status,
        qty_total, qty_open,
        avg_price, entry_price, ltp,
        settlement, product_type, exit_price, exit_time, pnl, duration_seconds, 
        entry_brokerage, exit_brokerage, brokerage, created_at, updated_at
      )
      VALUES (
        v_order.user_id, v_order.symbol, v_pos.side, 'closed',
        v_order.qty, 0,
        v_pos.avg_price, v_pos.entry_price, v_order.ltp_at_entry,
        v_order.segment, v_pos.product_type, v_order.fill_price, now(), v_pnl,
        EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer, 
        v_closed_entry_brokerage, v_brokerage, v_closed_entry_brokerage + v_brokerage, now(), now()
      )
      RETURNING id INTO v_closed_pos_id;

      -- 3. Record PNL transaction for the closed portion
      v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
      INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
      VALUES (v_order.user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', v_closed_pos_id::text);

    END IF;

  ELSE
    -- ─── ENTRY ORDER LOGIC ───
    -- D. Accumulate/create position
    IF v_pos_found THEN
      -- If same side, accumulate quantity & compute weighted average price
      IF v_pos.side = v_order.side THEN
        v_new_avg_price := ((v_pos.avg_price * v_pos.qty_open) + (v_order.fill_price * v_order.qty)) / (v_pos.qty_open + v_order.qty);

        UPDATE public.positions
        SET
          qty_open = qty_open + v_order.qty,
          qty_total = qty_total + v_order.qty,
          avg_price = v_new_avg_price,
          entry_price = v_new_avg_price,
          entry_brokerage = entry_brokerage + v_brokerage,
          brokerage = brokerage + v_brokerage,
          updated_at = now()
        WHERE id = v_pos.id;
      ELSE
        RAISE EXCEPTION 'Cannot open opposite position while existing position is active';
      END IF;
    ELSE
      -- Insert a brand new open position
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
        v_order.fill_price, v_order.fill_price, v_order.ltp_at_entry,
        v_order.segment, v_order.product_type, v_order.stop_loss, v_order.target, 
        v_brokerage, 0, v_brokerage, now(), now()
      );
    END IF;
  END IF;

  -- ─── FIRST TRADE BONUS LOGIC ───
  SELECT has_traded, parent_id INTO v_has_traded, v_parent_id_text
  FROM public.profiles WHERE id = v_order.user_id;

  IF NOT v_has_traded THEN
    UPDATE public.profiles SET has_traded = TRUE WHERE id = v_order.user_id;
    IF v_parent_id_text IS NOT NULL THEN
      UPDATE public.profiles
         SET referral_balance = referral_balance + 200
       WHERE id = v_parent_id_text::uuid;
      INSERT INTO public.referral_earnings
        (referrer_id, referred_user_id, transaction_id, commission_amount, earning_type)
      VALUES
        (v_parent_id_text::uuid, v_order.user_id, v_order.id, 200, 'FIRST_TRADE_BONUS');
    END IF;
  END IF;

END;
$$;

-- 5. Re-grant permissions
REVOKE EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.place_order(uuid, text, text, text, text, text, text, numeric, numeric, numeric, numeric, text, numeric, numeric, numeric, boolean, numeric) TO service_role;
ALTER TABLE public.referral_earnings ALTER COLUMN referred_user_id DROP NOT NULL;
-- 1. Add closed_by column to positions table to track user vs manual/system closures
ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS closed_by TEXT DEFAULT 'USER';

-- 2. Update close_position RPC to persist p_closed_by parameter
CREATE OR REPLACE FUNCTION public.close_position(
  p_position_id   uuid,
  p_user_id       uuid,
  p_ltp           numeric,
  p_exit_price    numeric,
  p_closed_by     text DEFAULT 'USER',
  p_brokerage     numeric DEFAULT 0
)
RETURNS numeric
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_pos          record;
  v_pnl          numeric;
  v_pnl_type     text;
  v_duration_sec integer;
  v_closed_margin numeric;
BEGIN
  -- Fetch & lock the position
  SELECT * INTO v_pos
  FROM public.positions
  WHERE id = p_position_id AND user_id = p_user_id AND status = 'open'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Position not found or already closed';
  END IF;

  -- Compute P&L
  IF v_pos.side = 'BUY' THEN
    v_pnl := (p_exit_price - v_pos.entry_price) * v_pos.qty_open;
  ELSE
    v_pnl := (v_pos.entry_price - p_exit_price) * v_pos.qty_open;
  END IF;
  v_duration_sec := EXTRACT(EPOCH FROM (now() - v_pos.entry_time))::integer;

  -- Compute proportional margin to return
  -- (If full exit, return full locked margin. If partial, return proportional).
  v_closed_margin := (v_pos.locked_margin * v_pos.qty_open) / v_pos.qty_total;

  -- Update position row
  UPDATE public.positions
  SET
    status = 'closed',
    exit_price = p_exit_price,
    exit_time = now(),
    pnl = v_pnl,
    duration_seconds = v_duration_sec,
    updated_at = now(),
    -- The caller passes p_brokerage for exit, but we don't charge it for now if they paid 2x entry. 
    -- We just append it to track if needed.
    exit_brokerage = exit_brokerage + p_brokerage,
    brokerage = brokerage + p_brokerage,
    locked_margin = 0, -- unlock margin
    closed_by = p_closed_by -- Store who closed the position
  WHERE id = p_position_id;

  -- Record PNL transaction
  v_pnl_type := CASE WHEN v_pnl >= 0 THEN 'PNL_CREDIT' ELSE 'PNL_DEBIT' END;
  
  INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
  VALUES (p_user_id, v_pnl_type, ABS(v_pnl), 'APPROVED', p_position_id::text);

  -- Record Exit Brokerage transaction (if any, typically 0 since charged upfront)
  IF p_brokerage > 0 THEN
    INSERT INTO public.transactions (user_id, type, amount, status, ref_id)
    VALUES (p_user_id, 'BROKERAGE_DEBIT', p_brokerage, 'APPROVED', 'BKG_EXIT_' || p_position_id::text);
  END IF;

  RETURN v_pnl;
END;
$$;

-- ==============================================================================
-- SECTION: Re-baseline Profile Balances Function
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.rebaseline_profile_balances()
RETURNS void AS $$
DECLARE
  r_profile RECORD;
  r_tx      RECORD;
  v_bal     numeric;
  v_sett    numeric;
  v_change  numeric;
BEGIN
  FOR r_profile IN SELECT id, email FROM public.profiles LOOP
    v_bal := 0;
    v_sett := 0;
    
    FOR r_tx IN 
      SELECT type, amount 
        FROM public.transactions 
       WHERE user_id = r_profile.id 
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
        v_sett := v_sett + v_bal;
        v_bal := 0;
      END IF;
    END LOOP;
    
    UPDATE public.profiles
       SET balance = v_bal,
           settlement_amount = v_sett,
           updated_at = now()
     WHERE id = r_profile.id;
  END LOOP;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

SELECT public.rebaseline_profile_balances();
