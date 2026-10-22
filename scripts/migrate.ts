import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createPool, transaction } from '../packages/db/src/index.js';
const pool=createPool();
try {
 await transaction(pool,async tx=>{
  await tx.query('SELECT pg_advisory_xact_lock(89431621)');
  await tx.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(new URL('../migrations/',import.meta.url))).filter(n=>n.endsWith('.sql')).sort()) {
   const sql=await readFile(new URL(`../migrations/${name}`,import.meta.url),'utf8');
   const hash=createHash('sha256').update(sql).digest('hex');
   const old=await tx.query('SELECT hash FROM schema_migrations WHERE name=$1',[name]);
   if(old.rows.length) { if(old.rows[0].hash!==hash) throw new Error(`Applied migration changed: ${name}`); continue; }
   await tx.query(sql); await tx.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)',[name,hash]);
   console.log(`Applied ${name}`);
  }
 });
} finally { await pool.end(); }
