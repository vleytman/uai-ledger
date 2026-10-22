import {execFile} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {copyFile, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {afterAll, describe, expect, it} from 'vitest';
import {id} from '../../contracts/src/index.js';
import {createPool, transaction} from '../../db/src/index.js';
import {ConnectionService, CredentialVault, type ConnectionSettings} from '../src/connections.js';

if(process.env.REQUIRE_INTEGRATION_TESTS==='1'&&!process.env.DATABASE_URL)throw new Error('DATABASE_URL required');
const integration=process.env.DATABASE_URL?describe:describe.skip;
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end();});
const execute=promisify(execFile);

integration('vault delivery to independent runtime processes',()=>{
 it('restored key opens persisted credentials; missing, wrong and malformed keys fail closed',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'uai-vault-runtime-'));
  const original=join(directory,'original.key'),restored=join(directory,'restored.key');
  const key=randomBytes(32),secret=`synthetic-only-${randomBytes(32).toString('hex')}`;
  const scope={organization_id:id('org'),application_id:id('app')};
  const actor={actor_id:'vault-runtime-test',reason:'Synthetic vault recovery acceptance'};
  const settings:ConnectionSettings={provider:'fake',name:'Vault runtime fixture',account_scope:{provider_account:'synthetic'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}};
  try{
   await writeFile(original,key.toString('base64'),{mode:0o600});
   await copyFile(original,restored);
   expect((await stat(restored)).mode&0o777).toBe(0o600);
   const connection=await transaction(pool!,async db=>{
    const service=new ConnectionService(db,undefined,new CredentialVault(key));
    const row=await service.create(scope,settings,actor);
    await service.rotateCredential(scope,row.id,row.revision,secret,actor);
    return row;
   });
   const stored=(await pool!.query('SELECT ciphertext,iv,tag FROM provider_credentials WHERE connection_id=$1',[connection.id])).rows;
   expect(JSON.stringify(stored)).not.toContain(secret);
   // Each child starts with a fresh environment and reads only its delivered file.
   // It emits a digest, never a credential, key, or connection URL.
   const source=`
import {createHash} from 'node:crypto';
import {loadRuntimeSecrets} from ${JSON.stringify(new URL('../../runtime-config/src/index.ts',import.meta.url).href)};
import {createPool} from ${JSON.stringify(new URL('../../db/src/index.ts',import.meta.url).href)};
import {ConnectionService,CredentialVault} from ${JSON.stringify(new URL('../src/connections.ts',import.meta.url).href)};
let pool;
try {
 await loadRuntimeSecrets();
 pool=createPool();
 const vault=process.env.UAI_VAULT_KEY?new CredentialVault(Buffer.from(process.env.UAI_VAULT_KEY,'base64')):undefined;
 const value=await new ConnectionService(pool,undefined,vault).resolveCredential(JSON.parse(process.env.TEST_SCOPE),process.env.TEST_CONNECTION);
 process.stdout.write(JSON.stringify({ok:true,digest:createHash('sha256').update(value).digest('hex')}));
} catch {process.stdout.write(JSON.stringify({ok:false}));}
finally {await pool?.end();}
`;
   const childFile=join(directory,'reader.mjs');
   await writeFile(childFile,source,{mode:0o600});
   async function readWith(file:string,requestedScope=scope){
    const env:NodeJS.ProcessEnv={...process.env,UAI_VAULT_KEY_FILE:file,TEST_SCOPE:JSON.stringify(requestedScope),TEST_CONNECTION:connection.id};
    delete env.UAI_VAULT_KEY;
    const result=await execute(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),childFile],{env,timeout:15000});
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(secret);
    return JSON.parse(result.stdout);
   }
   const expected={ok:true,digest:createHash('sha256').update(secret).digest('hex')};
   expect(await readWith(original)).toEqual(expected);
   await rm(original);
   expect(await readWith(restored)).toEqual(expected);
   expect(await readWith(original)).toEqual({ok:false});
   expect(await readWith(restored,{...scope,application_id:id('foreign')})).toEqual({ok:false});
   const wrong=join(directory,'wrong.key');
   await writeFile(wrong,randomBytes(32).toString('base64'),{mode:0o600});
   expect(await readWith(wrong)).toEqual({ok:false});
   await writeFile(wrong,'not-a-vault-key',{mode:0o600});
   expect(await readWith(wrong)).toEqual({ok:false});
   expect(await readFile(restored,'utf8')).toBe(key.toString('base64'));
  }finally{await rm(directory,{recursive:true,force:true});}
 },60000);
});
