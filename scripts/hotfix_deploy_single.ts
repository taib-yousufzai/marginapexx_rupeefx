import { Client } from 'pg';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

const file = process.argv[2];
if (!file) { console.error('Usage: npx ts-node scripts/hotfix_deploy_single.ts <sql-file>'); process.exit(1); }

const client = new Client({
  host: 'db.cpcvklekwwawgtgbyrmp.supabase.co',
  port: 5432, user: 'postgres',
  password: process.env.SUPABASE_DB_PASSWORD!,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
});

client.connect()
  .then(() => client.query(fs.readFileSync(file, 'utf8')))
  .then(() => { console.log(`✅ Deployed: ${file}`); return client.end(); })
  .catch(e => { console.error(`❌ Failed: ${e.message}`); client.end(); process.exit(1); });
