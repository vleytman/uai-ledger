import {readFile,readdir} from 'node:fs/promises';
import {afterAll,it,expect} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {randomUUID} from 'node:crypto';
if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
(pool?it:it.skip)('upgrades a populated pre-file schema without changing legacy versions or rename behavior',async()=>{
 await transaction(pool!,async tx=>{
  const schema=`migration_${randomUUID().replaceAll('-','')}`;
  await tx.query(`CREATE SCHEMA ${schema}`);await tx.query(`SET LOCAL search_path TO ${schema},public`);
  const directory=new URL('../../../migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&n<'0056').sort())await tx.query(await readFile(new URL(name,directory),'utf8'));
  const payload={id:'legacy',currency:'USD',rates:[]};
  await tx.query("INSERT INTO configuration_versions(id,organization_id,application_id,kind,key,version,payload,author,comment,created_at,published_at,status,display_name) VALUES('legacy','org','app','rate_card','legacy',1,$1,'fixture','original',now(),now(),'published','Before')",[payload]);
  await tx.query("INSERT INTO recipe_versions(id,organization_id,application_id,key,version,definition,created_at,actor_id) VALUES('recipe','org','app','legacy',1,$1,now(),'fixture')",[{key:'legacy',version:1,components:[]}]);
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')&&n>='0056').sort())await tx.query(await readFile(new URL(name,directory),'utf8'));
  expect((await tx.query("SELECT payload,file_source FROM configuration_versions WHERE id='legacy'")).rows[0]).toEqual({payload,file_source:null});
  expect((await tx.query("SELECT definition,file_source FROM recipe_versions WHERE id='recipe'")).rows[0]).toEqual({definition:{key:'legacy',version:1,components:[]},file_source:null});
  await tx.query("UPDATE configuration_versions SET display_name='After',revision=revision+1 WHERE id='legacy'");
  expect((await tx.query("SELECT display_name FROM configuration_versions WHERE id='legacy'")).rows[0].display_name).toBe('After');
  await tx.query(`DROP SCHEMA ${schema} CASCADE`);
 });
});

(pool?it:it.skip)('creates the complete current schema from an empty namespace',async()=>{
 await transaction(pool!,async tx=>{
  const schema=`clean_${randomUUID().replaceAll('-','')}`;await tx.query(`CREATE SCHEMA ${schema}`);await tx.query(`SET LOCAL search_path TO ${schema},public`);
  const directory=new URL('../../../migrations/',import.meta.url);for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await tx.query(await readFile(new URL(name,directory),'utf8'));
  expect((await tx.query("SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('allowance_ledger','configuration_file_adoptions','notification_rules')",[schema])).rows[0].n).toBe(3);
  await tx.query(`DROP SCHEMA ${schema} CASCADE`);
 });
});
