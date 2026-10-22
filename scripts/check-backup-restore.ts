/** Opt-in PostgreSQL restore drill for a synthetic load database. Never starts runtime roles. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,createHash} from 'node:crypto';
import {chmod,readFile,writeFile} from 'node:fs/promises';
import {createPool,transaction,type Tx} from '../packages/db/src/index.js';

const run=promisify(execFile);
const connection=process.env.DATABASE_URL,container=process.env.UAI_RESTORE_TEST_CONTAINER;
if(process.env.UAI_RESTORE_TEST_ONLY!=='1'||!connection||!container)throw new Error('restore_test_opt_in_required');
const sourceUrl=new URL(connection),sourceName=sourceUrl.pathname.slice(1);
if(!/^uai_load_[a-z0-9_]+$/.test(sourceName)||!sourceUrl.username)throw new Error('synthetic_source_database_required');
const suffix=randomUUID().replaceAll('-',''),targetName=`uai_restore_${suffix}`;
const artifact=`/tmp/uai-restore-${suffix}`,dump=`${artifact}.dump`,reportPath=`${artifact}.json`;
const targetUrl=new URL(sourceUrl);targetUrl.pathname=`/${targetName}`;
const source=createPool(sourceUrl.href),target=createPool(targetUrl.href);
const docker=async(...args:string[])=>run('docker',args,{maxBuffer:4*1024*1024});
const quote=(identifier:string)=>`"${identifier.replaceAll('"','""')}"`;
async function manifest(tx:Tx){
 const tables=(await tx.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
 const result:Record<string,{rows:string;hash:string}>= {};
 for(const {tablename} of tables){
  const row=(await tx.query(`SELECT count(*)::text AS rows,md5(COALESCE(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) AS hash FROM public.${quote(tablename)} t`)).rows[0];
  result[tablename]=row;
 }
 return result;
}
const client=await source.connect();let released=false;
let before:Awaited<ReturnType<typeof manifest>>|undefined;
try{
 await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 const snapshot=(await client.query('SELECT pg_export_snapshot() AS id')).rows[0].id;
 before=await manifest(client);
 await docker('exec',container,'pg_dump','-U',decodeURIComponent(sourceUrl.username),'-d',sourceName,'--format=custom','--no-owner','--no-acl',`--snapshot=${snapshot}`,`--file=${dump}`);
 await client.query('ROLLBACK');client.release();released=true;
 await docker('cp',`${container}:${dump}`,dump);await chmod(dump,0o600);
 await source.query(`CREATE DATABASE ${quote(targetName)}`);
 await docker('exec',container,'pg_restore','-U',decodeURIComponent(sourceUrl.username),'-d',targetName,'--no-owner','--no-acl','--exit-on-error',dump);
 const after=await manifest(target);
 const identical=JSON.stringify(before)===JSON.stringify(after);
 const journal=(await target.query('SELECT id,wallet_id FROM journal_transactions LIMIT 1')).rows[0];
 if(!journal)throw new Error('funded_fixture_required_for_restore_drill');
 async function rejectedProbe(sql:string,args:unknown[],expected:RegExp){
  try{await transaction(target,async tx=>{await tx.query(sql,args);await tx.query('SET CONSTRAINTS ALL IMMEDIATE');throw new Error('restore_constraint_probe_was_accepted')})}
  catch(error){if(expected.test((error as Error).message))return;throw error}
 }
 await rejectedProbe('UPDATE journal_transactions SET reason=$2 WHERE id=$1',[journal.id,'restore probe'],/Accounting history is immutable/);
 await rejectedProbe(`INSERT INTO journal_transactions(id,wallet_id,type,identity,actor_id,reason,created_at)
  VALUES($1,$2,'restore-probe',$1,'restore-drill','must reject an unbalanced journal',now())`,[randomUUID(),journal.wallet_id],/Unbalanced journal transaction/);
 const unbalanced=(await target.query(`SELECT count(*)::text AS count FROM (
  SELECT t.id FROM journal_transactions t LEFT JOIN journal_postings p ON p.transaction_id=t.id
  GROUP BY t.id HAVING COALESCE(sum(p.amount_units),0)<>0 OR count(p.id)<2
 ) bad`)).rows[0].count;
 const unreconciled=(await target.query(`SELECT count(*)::text AS count FROM lot_balances b
 CROSS JOIN LATERAL (VALUES ('available',b.available),('reserved',b.reserved),('revocation_reserved',b.revocation_reserved),
 ('consumed',b.consumed),('expired',b.expired),('revoked',b.revoked)) v(bucket,amount)
 WHERE v.amount<>(SELECT COALESCE(sum(p.amount_units),0) FROM journal_postings p WHERE p.lot_id=b.lot_id AND p.bucket=v.bucket)`)).rows[0].count;
 const requestStates=(await target.query('SELECT execution_status,settlement_status,count(*)::text AS count FROM execution_requests GROUP BY 1,2 ORDER BY 1,2')).rows;
 const report={source:sourceName,target:targetName,dump,sha256:createHash('sha256').update(await readFile(dump)).digest('hex'),checked_at:new Date().toISOString(),tables:before,identical,immutable_journal_enforced:true,balanced_journal_enforced:true,unbalanced_transactions:unbalanced,unreconciled_balances:unreconciled,request_states:requestStates,limits:'PostgreSQL snapshot only; no workers started, no blob/Redis restore or production RPO/RTO claim'};
 await writeFile(reportPath,JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify({report:reportPath,target:targetName,tables:Object.keys(before).length,identical,unbalanced,unreconciled}));
 if(!identical||unbalanced!=='0'||unreconciled!=='0')throw new Error('restore_verification_failed');
}finally{
 // A failed dump may leave its read snapshot open.
 if(!released){await client.query('ROLLBACK').catch(()=>{});client.release()}
 await docker('exec',container,'rm','-f',dump).catch(()=>{});
 await Promise.all([source.end(),target.end()]);
}
