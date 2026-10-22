import {readFile,writeFile,access} from 'node:fs/promises';
import {resolve} from 'node:path';
import {strict as assert} from 'node:assert';
import {createPool} from '../packages/db/src/index.js';
if(process.env.UAI_ENV!=='test')throw new Error('Test environment required');
const root=resolve('.data'),history=JSON.parse(await readFile(resolve(root,'demo/history.json'),'utf8')),pool=createPool();
try{
 if(process.argv.includes('--before')){
  const row=history.find((r:any)=>r.profile==='image.standard');assert(row?.operation_id&&row.files?.length);
  const requests=(await pool.query('SELECT id FROM execution_requests WHERE operation_id=$1',[row.operation_id])).rows.map(r=>r.id);
  const counts=(await pool.query('SELECT count(*)::int count FROM journal_transactions WHERE references_json->>\'operation_id\'=$1 OR references_json->>\'request_id\'=ANY($2::text[])',[row.operation_id,requests])).rows[0].count;
  await writeFile(resolve(root,'qa-delete-baseline.json'),JSON.stringify({id:row.id,operation_id:row.operation_id,files:row.files,requests,counts}));console.log('Deletion baseline stored; remove the standalone image conversation in demo.');
 }else{
  const old=JSON.parse(await readFile(resolve(root,'qa-delete-baseline.json'),'utf8'));assert(!history.some((r:any)=>r.id===old.id));for(const file of old.files)await assert.rejects(access(resolve(root,'demo',file)));
  const tombstone=(await pool.query('SELECT * FROM storage_tombstones WHERE operation_id=$1',[old.operation_id])).rows[0];assert(tombstone);assert.equal(tombstone.status,'completed');
  const counts=(await pool.query('SELECT count(*)::int count FROM journal_transactions WHERE references_json->>\'operation_id\'=$1 OR references_json->>\'request_id\'=ANY($2::text[])',[old.operation_id,old.requests])).rows[0].count;assert.equal(counts,old.counts);assert(counts>0);
  assert.equal((await pool.query('SELECT count(*)::int count FROM storage_inputs WHERE operation_id=$1 AND content IS NOT NULL',[old.operation_id])).rows[0].count,0);
  console.log(JSON.stringify({A91:'passed',local_history_removed:true,local_files_removed:old.files.length,uai_tombstone:tombstone.status,financial_entries_retained:counts}));
 }
}finally{await pool.end()}
