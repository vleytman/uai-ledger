import {transaction} from '../../db/src/index.js';
import {issueToken} from '../../auth/src/index.js';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {providerAdmission} from '../src/provider-admission.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());
describe.skipIf(!enabled)('Provider quota shadow preview',()=>{
 it('compares with actual weighted admission without creating duplicate intents, permits or calls',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,f=await seedLoadFixture(pool,1),broker=providerAdmission(pool,process.env.REDIS_URL!,id('shadow')),api=createApi(pool),deps=defaultRuntime(pool);
  const group=(await pool.query("SELECT g.id FROM provider_quota_groups g JOIN provider_quota_bindings b ON b.group_id=g.id WHERE g.organization_id=$1 AND b.model='fake-text'",[f.scope.organization_id])).rows[0].id;
  await pool.query('UPDATE provider_quota_rules SET capacity=2 WHERE group_id=$1',[group]);
  const samples:Array<{preview:unknown;actual:unknown}>=[],requestIds:string[]=[];let calls=0;
  const factory=deps.adapter;deps.onDelta=undefined;
  deps.adapter=async(...args)=>{const adapter=await factory(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(...args)=>{calls++;return execute(...args)};return adapter};
  const runtime={...deps,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission,
   admit:async(...args:Parameters<typeof broker.admit>)=>{
    const count=async()=>Number((await pool.query('SELECT count(*) n FROM dispatch_admissions WHERE group_id=$1',[group])).rows[0].n);
    const before=await count();const preview=await broker.preview(...args);expect(await count()).toBe(before);
    const actual=await broker.admit(...args);samples.push({preview,actual});return actual;
   },limits:{backend:'bullmq' as const,generation:0},
  };
  try{
   for(let i=0;i<3;i++){
    const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':id('shadow-invoke')},payload:{account_id:f.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:`Shadow ${i}`},parameters:{max_output_tokens:100}}});
    expect(response.statusCode,response.body).toBe(202);requestIds.push(response.json().request_id);
    expect(await executeRequest(pool,runtime,response.json().request_id)).toMatchObject({state:i<2?'succeeded':'waiting'});
   }
   expect(samples[0]).toMatchObject({preview:{mode:'shadow',would_allow:null,reason:'not_ready'},actual:{allowed:true}});
   expect(samples[1]).toMatchObject({preview:{mode:'shadow',would_allow:true},actual:{allowed:true}});
   expect(samples[2]).toMatchObject({preview:{mode:'shadow',would_allow:false,reason:'limited'},actual:{allowed:false,reason:'waiting_rate_limit'}});
   expect(calls).toBe(2);
   expect((await pool.query('SELECT state,count(*)::int n FROM dispatch_admissions WHERE group_id=$1 GROUP BY state ORDER BY state',[group])).rows).toEqual([{state:'admitted',n:2},{state:'rejected',n:1}]);
   expect((await pool.query('SELECT count(*)::int n FROM execution_attempts a JOIN execution_requests r ON r.id=a.request_id WHERE r.organization_id=$1',[f.scope.organization_id])).rows[0].n).toBe(2);
   const waiting=requestIds[2]!,stored=(await pool.query('SELECT quota_wait FROM execution_requests WHERE id=$1',[waiting])).rows[0].quota_wait;
   expect(stored).toMatchObject({group_id:group,metric:'requests',rule:'requests',demand:'1',available:'0',capacity:'2',window_ms:60000});
   expect(Number.isFinite(Date.parse(stored.checked_at))).toBe(true);
   const admin=await transaction(pool,tx=>issueToken(tx,{...f.scope,account_ids:null,scopes:['operations:admin'],max_grant_units:null,expires_at:null}));
   const queue=await api.inject({method:'GET',url:'/v1/admin/queue',headers:{authorization:`Bearer ${admin.token}`}});expect(queue.statusCode,queue.body).toBe(200);
   expect(queue.json().data.find((row:any)=>row.id===waiting).quota_wait).toEqual(stored);
   const other=await seedLoadFixture(pool,1),foreign=await transaction(pool,tx=>issueToken(tx,{...other.scope,account_ids:null,scopes:['operations:admin'],max_grant_units:null,expires_at:null}));
   const hidden=await api.inject({method:'GET',url:'/v1/admin/queue',headers:{authorization:`Bearer ${foreign.token}`}});expect(hidden.json().data).toEqual([]);
   const publicRequest=await api.inject({method:'GET',url:`/v1/requests/${waiting}`,headers:{authorization:`Bearer ${f.token}`}});expect(publicRequest.json()).not.toHaveProperty('quota_wait');
   const event=(await pool.query("SELECT data FROM outbox_events WHERE resource->>'id'=$1 AND type='request.waiting_rate_limit' ORDER BY sequence DESC LIMIT 1",[waiting])).rows[0].data;
   expect(event).not.toHaveProperty('quota_wait');
   await pool.query('UPDATE provider_quota_rules SET capacity=3 WHERE group_id=$1',[group]);
   expect((await pool.query('SELECT quota_wait FROM execution_requests WHERE id=$1',[waiting])).rows[0].quota_wait).toEqual(stored);
   await pool.query('UPDATE execution_requests SET not_before=now() WHERE id=$1',[waiting]);
   expect(await executeRequest(pool,runtime,waiting)).toMatchObject({state:'succeeded'});
   expect((await pool.query('SELECT quota_wait FROM execution_requests WHERE id=$1',[waiting])).rows[0].quota_wait).toBeNull();expect(calls).toBe(3);

  }finally{await broker.close();await api.close();vi.unstubAllEnvs()}
 });
 it('reports provider concurrency while a real synthetic execution occupies the slot',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,f=await seedLoadFixture(pool,1,1),broker=providerAdmission(pool,process.env.REDIS_URL!,id('shadow-slots')),api=createApi(pool),deps=defaultRuntime(pool);
  let release!:()=>void,entered=false;const gate=new Promise<void>(resolve=>{release=resolve});
  const factory=deps.adapter;deps.onDelta=undefined;
  deps.adapter=async(...args)=>{const adapter=await factory(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(...args)=>{entered=true;await gate;return execute(...args)};return adapter};
  let running:ReturnType<typeof executeRequest>|undefined;
  const invoke=async()=>{const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':id('invoke')},payload:{account_id:f.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Held slot'},parameters:{max_output_tokens:100}}});expect(response.statusCode,response.body).toBe(202);return response.json().request_id as string};
  try{
   const first=await invoke(),second=await invoke();
   running=executeRequest(pool,{...deps,admit:broker.admit,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission,limits:{backend:'bullmq',generation:0}},first);
   await expect.poll(()=>entered).toBe(true);
   const request=(await pool.query('SELECT * FROM execution_requests WHERE id=$1',[second])).rows[0],variant=request.route.primary,context=await deps.context(f.scope,request,variant),adapter=await deps.adapter(f.scope,variant,context);
   expect(await broker.preview(f.scope,request,variant,context,adapter)).toMatchObject({mode:'shadow',would_allow:false,reason:'concurrency'});
   release();expect(await running).toMatchObject({state:'succeeded'});
   expect(await broker.preview(f.scope,request,variant,context,adapter)).toMatchObject({mode:'shadow',would_allow:true});
  }finally{release();await running;await broker.close();await api.close();vi.unstubAllEnvs()}
 });
});
