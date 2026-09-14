import { Client } from 'pg';

async function main() {
  const client = new Client({
    host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
    port: 5432,
    user: 'postgres',
    password: '9NGKXKwLoXHyUF2c',
    database: 'postgres',
    ssl: {
      rejectUnauthorized: false
    }
  });

  try {
    await client.connect();
    console.log("Connected successfully!");

    // Start a transaction so we can rollback at the end
    await client.query('BEGIN');

    const v_user = '00000000-0000-0000-0000-000000000008';
    
    // Clean up
    await client.query(`DELETE FROM public.transactions WHERE user_id = $1`, [v_user]);
    await client.query(`DELETE FROM public.positions WHERE user_id = $1`, [v_user]);
    await client.query(`DELETE FROM public.orders WHERE user_id = $1`, [v_user]);
    await client.query(`DELETE FROM public.profiles WHERE id = $1`, [v_user]);
    await client.query(`DELETE FROM auth.users WHERE id = $1`, [v_user]);

    // Insert user, profile, deposit
    await client.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'debug_ct7@marginapex.com')`, [v_user]);
    await client.query(`INSERT INTO public.profiles (id, active, role, balance, settlement_amount, client_id) VALUES ($1, true, 'user', 50000, 50000, 'DB_CT8')`, [v_user]);
    await client.query(`INSERT INTO public.transactions (user_id, type, amount, status, ref_id) VALUES ($1, 'DEPOSIT', 50000, 'APPROVED', 'CT_DEPOSIT')`, [v_user]);

    // Seed test symbol
    await client.query(`INSERT INTO public.script_settings (symbol, lot_size) VALUES ('CT_SYM', 1) ON CONFLICT (symbol) DO NOTHING`);

    // CONTRACT 1: place_order_v2 entry
    const order1 = await client.query(`
      SELECT public.place_order_v2(
        $1, 'CT_SYM', 'CT_SYM', 'EQ', 'BUY', 'MARKET', 'INTRADAY',
        10, 10, 100, 100, false, 0, 'EXECUTED',
        p_expected_margin => 1000,
        p_expected_brokerage => 20,
        p_idempotency_key => 'ct1_entry'
      ) AS id
    `, [v_user]);
    const orderId = order1.rows[0].id;

    // Get position ID
    let res = await client.query(`SELECT id FROM public.positions WHERE user_id = $1 AND symbol = 'CT_SYM' AND status = 'open'`, [v_user]);
    const posId = res.rows[0].id;

    // CONTRACT 4: close_position_v2
    await client.query(`
      SELECT public.close_position_v2(
        $1, 10, 120, 'USER', 15, 'ct4_close'
      ) AS pnl
    `, [posId]);

    // CONTRACT 7: CARRY position
    await client.query(`
      SELECT public.place_order_v2(
        $1, 'CT_SYM', 'CT_SYM', 'EQ', 'BUY', 'MARKET', 'CARRY',
        5, 5, 200, 200, false, 0, 'EXECUTED',
        p_expected_margin => 500,
        p_expected_brokerage => 0,
        p_idempotency_key => 'ct7_carry_entry'
      ) AS id
    `, [v_user]);

    res = await client.query(`SELECT id FROM public.positions WHERE user_id = $1 AND symbol = 'CT_SYM' AND status = 'open' AND product_type = 'CARRY'`, [v_user]);
    const carryPosId = res.rows[0].id;

    // Print transactions before carry charge
    let txs = await client.query(`SELECT type, amount, status, ref_id FROM public.transactions WHERE user_id = $1`, [v_user]);
    console.log("=== Transactions BEFORE carry charge ===");
    console.log(txs.rows);

    res = await client.query(`SELECT balance FROM public.profiles WHERE id = $1`, [v_user]);
    console.log("Balance before carry charge:", res.rows[0].balance);

    // Apply carry charge
    await client.query(`
      SELECT public.apply_carry_charges_v1(
        $1, 50, 'CT7_CARRY_CHG'
      ) AS charged
    `, [carryPosId]);

    // Print transactions after carry charge
    txs = await client.query(`SELECT type, amount, status, ref_id FROM public.transactions WHERE user_id = $1`, [v_user]);
    console.log("=== Transactions AFTER carry charge ===");
    console.log(txs.rows);

    res = await client.query(`SELECT balance FROM public.profiles WHERE id = $1`, [v_user]);
    console.log("Balance after carry charge:", res.rows[0].balance);

    await client.query('ROLLBACK');
  } catch (err) {
    console.error("Error during debug execution:", err);
    try {
      await client.query('ROLLBACK');
    } catch (e) {}
  } finally {
    await client.end();
  }
}

main();
