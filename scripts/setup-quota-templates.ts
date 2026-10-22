import {readFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {createPool,transaction} from '../packages/db/src/index.js';
import {DomainError,systemClock} from '../packages/contracts/src/index.js';
import {previewQuotaTemplateSetup,applyQuotaTemplateSetup,type TemplateSetup} from '../packages/queue/src/quota-template-setup.js';
const {values}=parseArgs({options:{file:{type:'string'},apply:{type:'boolean',default:false},revision:{type:'string'},actor:{type:'string'},reason:{type:'string'}}});
if(!values.file)throw new Error('--file is required');
if(values.apply&&(!values.revision||!values.actor||!values.reason?.trim()))throw new Error('--apply requires reviewed --revision, --actor and --reason');
const manifest=JSON.parse(await readFile(values.file,'utf8')) as {organization_id:string;application_id:string;setup:TemplateSetup};
if(!manifest.organization_id||!manifest.application_id)throw new Error('organization_id and application_id are required');
const pool=createPool(),scope={organization_id:manifest.organization_id,application_id:manifest.application_id};
try{
 const result=await transaction<unknown>(pool,tx=>values.apply?applyQuotaTemplateSetup(tx,scope,systemClock,manifest.setup,values.revision!,{actor_id:values.actor!,reason:values.reason!}):previewQuotaTemplateSetup(tx,scope,manifest.setup));
 console.log(JSON.stringify({mode:values.apply?'applied':'preview',result},null,2));
}catch(error){console.error(JSON.stringify(error instanceof DomainError?{code:error.code,message:error.message}:{code:'quota_template_setup_failed'}));process.exitCode=1}finally{await pool.end()}
