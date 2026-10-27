import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

if (!process.env.DATABASE_URL) throw new Error('Defina DATABASE_URL antes de aplicar as migrações.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c search_path=glicocare,public', ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: true } });
try {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const files = (await readdir(resolve(root, 'migrations'))).filter((file) => file.endsWith('.sql')).sort();
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [file]); if (done.rowCount) continue;
    const sql = await readFile(resolve(root, 'migrations', file), 'utf8'); const client = await pool.connect();
    try { await client.query('BEGIN'); await client.query(sql); await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]); await client.query('COMMIT'); console.log(`Migração aplicada: ${file}`); }
    catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
} finally { await pool.end(); }
