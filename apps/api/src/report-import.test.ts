import {afterAll,describe,it,expect,vi} from 'vitest';
import {randomBytes} from 'node:crypto';
import {createPool,transaction} from '../../../packages/db/src/index.js';
import {ManualClock,id,type Scope} from '../../../packages/contracts/src/index.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {getWallet} from '../../../packages/accounting/src/index.js';
import {ConnectionService} from '../../../packages/reconciliation/src/index.js';
import {createApi} from './server.js';
const pool=process.env.DATABASE_URL?createPool():null;afterAll(async()=>pool?.end());
describe.skipIf(!pool)('Administrative report import boundary',()=>{
 it('uses a separate encrypted reporting credential, requires network opt-in, and never changes credits',async()=>{
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},clock=new ManualClock(new Date('2026-09-18T00:00:00Z')),oldKey=process.env.UAI_VAULT_KEY,oldNetwork=process.env.UAI_ALLOW_REPORTING_API;process.env.UAI_VAULT_KEY=randomBytes(32).toString('base64');delete process.env.UAI_ALLOW_REPORTING_API;
  const data=await transaction(pool!,async tx=>{await tx.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$3)',[scope.application_id,scope.organization_id,'Reporting boundary']);await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$4)',[scope.account_id,scope.organization_id,scope.application_id,'test']);const wallet=await getWallet(tx,scope,clock);const connection=await new ConnectionService(tx,clock).create(scope,{provider:'openai',name:'Synthetic admin reporting',account_scope:{organization_id:'org-fixture'},capabilities:{usage_reporting:true,cost_reporting:true,balance_reporting:false,request_cost_lookup:false,reporting_granularity:['1d'],reporting_lag_seconds:0},limits:{},risk_policy:{}},{actor_id:'test',reason:'Fixture report only'});const auth=await issueToken(tx,{...scope,account_ids:null,scopes:['operations:admin','config:write'],max_grant_units:null,expires_at:null});return {wallet,connection,auth}});
  const app=createApi(pool!,clock),headers={authorization:`Bearer ${data.auth.token}`,'idempotency-key':'credential'};
  const http=vi.fn(async()=>new Response(JSON.stringify({has_more:false,data:[{start_time:Date.parse('2026-09-01T00:00:00Z')/1000,end_time:Date.parse('2026-09-02T00:00:00Z')/1000,results:[{amount:{value:'0.010000001',currency:'usd'}}]}]})));
  vi.stubGlobal('fetch',http);
  try{
   const credential=await app.inject({method:'POST',url:`/v1/admin/connections/${data.connection.id}/report-credential`,headers,payload:{revision:data.connection.revision,secret:'fixture-reporting-key-only',credential_scope:{organization_id:'org-fixture'},reason:'Test report credential'}});expect(credential.statusCode).toBe(200);expect(credential.body).not.toContain('fixture-reporting-key-only');expect(credential.json().credential_status).toBe('missing');
   const command={method:'POST' as const,url:`/v1/admin/connections/${data.connection.id}/import-cost-report`,headers:{...headers,'idempotency-key':'import'},payload:{period_start:'2026-09-01T00:00:00Z',period_end:'2026-09-02T00:00:00Z',identity:'report-fixture',reason:'Fixture report'}};
   expect((await app.inject(command)).statusCode).toBe(503);expect(http).not.toHaveBeenCalled();
   process.env.UAI_ALLOW_REPORTING_API='true';const response=await app.inject(command);expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({provider_units:'10000001',status:'discrepancy'});
   const repeated=await app.inject(command);expect(repeated.statusCode).toBe(200);expect(repeated.json().id).toBe(response.json().id);
   const wallet=await transaction(pool!,tx=>getWallet(tx,scope,clock));expect(wallet).toEqual(data.wallet);expect((await pool!.query('SELECT count(*)::int count FROM reconciliation_runs WHERE application_id=$1',[scope.application_id])).rows[0].count).toBe(1);
   expect(http.mock.calls.length).toBeGreaterThan(0);
  }finally{vi.unstubAllGlobals();await app.close();if(oldKey===undefined)delete process.env.UAI_VAULT_KEY;else process.env.UAI_VAULT_KEY=oldKey;if(oldNetwork===undefined)delete process.env.UAI_ALLOW_REPORTING_API;else process.env.UAI_ALLOW_REPORTING_API=oldNetwork;}
 });
});
