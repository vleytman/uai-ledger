import {writeFile,readFile} from 'node:fs/promises';
import {createPool} from '../packages/db/src/index.js';
import {smokeManifest,continuationSmokeManifest,runAlternativeSmoke} from './lib/alternative-smoke.js';
const mode=process.argv[2]??'manifest',output=process.argv[3];
const continuationFrom=process.env.UAI_AMI_CONTINUATION_REPORT?JSON.parse(await readFile(process.env.UAI_AMI_CONTINUATION_REPORT,'utf8')):undefined;
const resumeFrom=process.env.UAI_AMI_RESUME_REPORT?JSON.parse(await readFile(process.env.UAI_AMI_RESUME_REPORT,'utf8')):undefined;
if(mode==='manifest'){const manifest=continuationFrom?continuationSmokeManifest(continuationFrom):smokeManifest();if(output)await writeFile(output,JSON.stringify(manifest,null,2)+'\n');else console.log(JSON.stringify(manifest,null,2));}
else{
 if(!['fixture','live'].includes(mode))throw new Error('Use manifest, fixture or live');
 const url=new URL(process.env.DATABASE_URL??'');if(!['localhost','127.0.0.1'].includes(url.hostname)||!/^\/uai_ami_(?:test|live)/.test(url.pathname))throw new Error('Use a dedicated local uai_ami_test or uai_ami_live database');
 if(!output)throw new Error('An output report path is required');
 const pool=createPool();try{const report=await runAlternativeSmoke(pool,mode==='live',{deferProviders:process.env.UAI_AMI_DEFER_PROVIDERS?.split(',').filter(Boolean),continuationFrom,resumeFrom});await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({status:report.status,calls:report.calls,report:output}));if(report.status!=='passed')process.exitCode=1;}finally{process.env.UAI_ALLOW_REAL_PROVIDERS='false';await pool.end();}
}
