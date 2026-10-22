import {exportLegacyConfiguration} from '../packages/configuration/src/export.js';
import {adoptConfiguration} from '../packages/configuration/src/adoption.js';
import {readFile,realpath,writeFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {createPool,transaction} from '../packages/db/src/index.js';
import {parseConfiguration,bindingsSchema,previewConfiguration,publishConfiguration,activateConfiguration} from '../packages/configuration/src/index.js';
const {values,positionals}=parseArgs({allowPositionals:true,options:{baseline:{type:'string'},reason:{type:'string'},bundle:{type:'string'},file:{type:'string'},bindings:{type:'string'},organization:{type:'string'},application:{type:'string'},actor:{type:'string'},release:{type:'string'},revision:{type:'string'},'allow-dirty':{type:'boolean',default:false}}});
const [mode]=positionals;
if(!['validate','preview','publish','adopt','export','activate','status'].includes(mode)||positionals.length!==1)throw new Error('Usage: configuration validate|preview|publish|activate|status --file <path> --bindings <local JSON> --organization <id> --application <id> --actor <id>. activate: --release <id> --revision <current revision, initially 0>.');
let document:ReturnType<typeof parseConfiguration>|undefined,provenance;
if(['validate','preview','publish','adopt'].includes(mode)){
 if(!values.file)throw new Error('--file required');
 const root=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
 const path=relative(root,await realpath(resolve(values.file)));
 if(isAbsolute(path)||path.startsWith('..'))throw new Error('Definition must be inside this Git repository');
 const bytes=await readFile(resolve(root,path));document=parseConfiguration(JSON.parse(bytes.toString('utf8')));
 const git_revision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 let git_dirty=true;try{git_dirty=!bytes.equals(execFileSync('git',['show',`${git_revision}:${path}`],{stdio:['ignore','pipe','ignore']}))}catch{/* New working-tree file. */}
 if(['publish','adopt'].includes(mode)&&git_dirty&&!values['allow-dirty'])throw new Error('Definition differs from HEAD; commit it or explicitly use --allow-dirty for local work.');
 provenance={path,git_revision,git_dirty,content_hash:createHash('sha256').update(bytes).digest('hex'),publisher:values.actor??'local-validator'};
}
{
 if(!values.organization||!values.application)throw new Error('--organization and --application required');
 const scope={organization_id:values.organization,application_id:values.application};
 if(['publish','adopt','activate'].includes(mode)&&!values.actor)throw new Error('--actor required');
 const pool=createPool();
 try{
  const result=await transaction(pool,async tx=>{
   if(mode==='export'){
    if(!values.file||!values.bindings||!values.baseline||!values.bundle)throw new Error('export requires --file, --bindings, --baseline and --bundle');
    const exported=await exportLegacyConfiguration(tx,scope,values.bundle);
    await writeFile(values.file,JSON.stringify(exported.document,null,2)+'\n',{flag:'wx'});
    await writeFile(values.bindings,JSON.stringify(exported.bindings,null,2)+'\n',{flag:'wx',mode:0o600});
    await writeFile(values.baseline,JSON.stringify(exported.baselines,null,2)+'\n',{flag:'wx',mode:0o600});
    return {exported:exported.document.resources.length,profiles:exported.document.resources.filter(r=>r.kind==='recipe').length,activation:'unchanged'};
   }
   if(mode==='status')return (await tx.query('SELECT r.id,r.bundle_key,r.digest,r.provenance,r.created_at,a.release_id=r.id AS active,a.revision AS activation_revision FROM configuration_releases r LEFT JOIN configuration_activations a USING(organization_id,application_id,bundle_key) WHERE r.organization_id=$1 AND r.application_id=$2 ORDER BY r.created_at DESC',[scope.organization_id,scope.application_id])).rows;
   if(mode==='activate'){
    if(!values.release||values.revision===undefined||!/^\d+$/.test(values.revision))throw new Error('--release and --revision required');
    return activateConfiguration(tx,scope,values.release,Number(values.revision),values.actor!);
   }
   if(!values.bindings)throw new Error('--bindings required');
   const bindings=bindingsSchema.parse(JSON.parse(await readFile(values.bindings,'utf8')));
   if(mode==='adopt'){if(!values.baseline||!values.reason)throw new Error('adopt requires --baseline and --reason');return adoptConfiguration(tx,scope,document,bindings,provenance!,JSON.parse(await readFile(values.baseline,'utf8')),values.reason);}
   const checked=await (mode==='publish'?publishConfiguration:previewConfiguration)(tx,scope,document,bindings,provenance!);
   return mode==='validate'?{valid:true,bundle_key:document!.bundle_key,resources:checked.resources,activation:'unchanged'}:checked;
  });
  console.log(JSON.stringify(result,null,2));
 }finally{await pool.end()}
}
