/** Final local demo cutover after an unchanged reviewed export and a local database backup. */
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createPool,transaction} from '../packages/db/src/index.js';
import {hash} from '../packages/contracts/src/index.js';
import {exportLegacyConfiguration} from '../packages/configuration/src/export.js';
import {adoptConfiguration} from '../packages/configuration/src/adoption.js';
import {activateConfiguration} from '../packages/configuration/src/index.js';
const url=new URL(process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||url.pathname!=='/uai_local')throw new Error('Only the local demo database is permitted');
if(!process.argv.includes('--execute'))throw new Error('Explicit --execute required for local cutover');
const backup=process.argv.find(v=>v.startsWith('--backup='))?.slice(9);if(!backup||!backup.startsWith('.data/')||(await stat(backup)).size<1000||(await readFile(backup)).subarray(0,5).toString()!=='PGDMP')throw new Error('A local pg_dump custom backup is required');
const config=JSON.parse(await readFile('.data/demo-config.json','utf8')),file='configurations/ai/legacy-local.json',bytes=await readFile(file),document=JSON.parse(bytes.toString()),bindings=JSON.parse(await readFile('.data/legacy-configuration-bindings.json','utf8')),pool=createPool();
try{
 const result=await transaction(pool,async tx=>{
  const scope=(await tx.query('SELECT organization_id,application_id FROM accounts WHERE id=$1',[config.account_id])).rows[0];if(!scope)throw new Error('Local demo account missing');
  const exported=await exportLegacyConfiguration(tx,scope,document.bundle_key);
  if(hash(exported.document)!==hash(document)||hash(exported.bindings)!==hash(bindings))throw new Error('Local definitions changed: review and export again');
  const operational=async()=>({connections:(await tx.query('SELECT * FROM provider_connections WHERE organization_id=$1 AND application_id=$2 ORDER BY id',[scope.organization_id,scope.application_id])).rows,wallets:(await tx.query('SELECT * FROM wallets WHERE organization_id=$1 AND application_id=$2 ORDER BY id',[scope.organization_id,scope.application_id])).rows});
  const before=hash(await operational());
  const release=await adoptConfiguration(tx,scope,document,bindings,{path:file,git_revision:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),git_dirty:true,content_hash:createHash('sha256').update(bytes).digest('hex'),publisher:'local-paid-api-migration'},exported.baselines,'Approved PA-I08 local profile migration; no pricing or operational changes');
  const activation=await activateConfiguration(tx,scope,release.id,0,'local-paid-api-migration');
  if(hash(await operational())!==before)throw new Error('Operational state changed during cutover; rollback');
  return {release_id:release.id,resources:release.resources.length,profiles:document.resources.filter((r:any)=>r.kind==='recipe').length,activation_revision:activation.revision,connections_and_wallets_unchanged:true};
 });console.log(JSON.stringify(result));
}finally{await pool.end()}
