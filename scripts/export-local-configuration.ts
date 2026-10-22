/** Read-only export of the local demo installation; never reads provider credentials. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createPool,transaction} from '../packages/db/src/index.js';
import {exportLegacyConfiguration} from '../packages/configuration/src/export.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/uai_local')throw new Error('Only the local demo database is permitted');
const config=JSON.parse(await readFile('.data/demo-config.json','utf8')),pool=createPool();
try{
 const result=await transaction(pool,async tx=>{
  await tx.query('SET TRANSACTION READ ONLY');
  const scope=(await tx.query('SELECT organization_id,application_id FROM accounts WHERE id=$1',[config.account_id])).rows[0];if(!scope)throw new Error('Local demo account missing');
  return exportLegacyConfiguration(tx,scope,'local-ai-profiles');
 });
 await mkdir('configurations/ai',{recursive:true});
 await writeFile('configurations/ai/legacy-local.json',JSON.stringify(result.document,null,2)+'\n',{flag:'wx'});
 await writeFile('.data/legacy-configuration-bindings.json',JSON.stringify(result.bindings,null,2)+'\n',{mode:0o600,flag:'wx'});
 await writeFile('.data/legacy-configuration-baseline.json',JSON.stringify(result.baselines,null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({profiles:result.document.resources.filter(r=>r.kind==='recipe').length,resources:result.document.resources.length,activation:'unchanged'}));
}finally{await pool.end()}
