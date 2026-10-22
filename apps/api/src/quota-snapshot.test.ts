import {afterAll,afterEach,describe,it,expect,vi} from 'vitest';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {id} from '../../../packages/contracts/src/index.js';
import {apiSchemas} from '../../../packages/contracts/api.js';
import {QuotaStore} from '../../../packages/queue/src/quota.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null,url=process.env.REDIS_URL;
afterAll(async()=>{await pool?.end()});afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs()});
describe.skipIf(!pool||!url)('Administrative quota snapshots',()=>{
 it('scopes diagnostics, reports recovery and outages, and rejects configuration races',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota'),foreign=id('quota'),installation=id('snapshot');
  vi.stubEnv('UAI_INSTALLATION_ID',installation);
  const tokens=await transaction(pool!,async tx=>{
   await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
   for(const [g,org] of [[group,scope.organization_id],[foreign,id('org')]]){
    await tx.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','epoch','synthetic')",[g,org]);
    await tx.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'rpm','requests',100,60000)",[g]);
   }
   const token=(scopes:string[],account_ids:string[]|null=null)=>issueToken(tx,{...scope,scopes,account_ids,max_grant_units:null,expires_at:null});
   return {read:await token(['operations:admin']),product:await token(['config:write']),restricted:await token(['operations:admin'],[scope.account_id])};
  });
  const app=createApi(pool!),store=new QuotaStore(url!,installation,group);
  const read=(g=group,token:string|undefined=tokens.read.token)=>app.inject({method:'GET',url:`/v1/admin/provider-quotas/${g}/snapshot`,headers:token?{authorization:`Bearer ${token}`}:{}});
  try{
   await store.connect();expect((await read(group,'')).statusCode).toBe(401);
   for(const t of [tokens.product,tokens.restricted])expect((await read(group,t.token)).statusCode).toBe(403);
   expect((await read(foreign)).statusCode).toBe(404);
   expect((await read()).json()).toMatchObject({status:'not_ready',rules:[]});
   await store.markRestored('epoch');await store.acquire('epoch','test',[{key:'rpm',capacity:100,amount:30,window_ms:60000}]);
   const result=await read();expect(result.statusCode).toBe(200);expect(result.headers['cache-control']).toBe('no-store');
   expect(result.json()).toMatchObject({status:'ready',rules_revision:1,rules:[{key:'rpm',used:'30',local_remaining:'70',available:'70'}]});
   expect(apiSchemas.QuotaSnapshotResponse.safeParse(result.json()).success).toBe(true);
   await pool!.query("UPDATE provider_quota_groups SET blocked_until=now()+interval '1 minute' WHERE id=$1",[group]);
   expect((await read()).json()).toMatchObject({status:'ready',rules:[{available:'0',local_remaining:'70'}]});
   const snapshot=QuotaStore.prototype.snapshot;
   const race=vi.spyOn(QuotaStore.prototype,'snapshot').mockImplementationOnce(async function(this:QuotaStore,epoch,rules){const value=await snapshot.call(this,epoch,rules);await pool!.query('UPDATE provider_quota_groups SET revision=revision+1 WHERE id=$1',[group]);return value});
   expect((await read()).json()).toMatchObject({status:'configuration_changed',rules:[]});race.mockRestore();
   const outage=vi.spyOn(QuotaStore.prototype,'snapshot').mockRejectedValueOnce(new Error('private connection details'));
   const unavailable=await read();expect(unavailable.json()).toMatchObject({status:'unavailable',rules:[]});expect(unavailable.body).not.toContain('private');outage.mockRestore();
   vi.stubEnv('UAI_INSTALLATION_ID','');expect((await read()).json()).toMatchObject({status:'not_configured',rules:[]});
  }finally{await store.close();await app.close()}
 });
});
