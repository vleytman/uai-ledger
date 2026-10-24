import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {getReservation,getWallet} from '../../accounting/src/index.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';
import {startScheduler} from '../src/scheduler-loop.js';
import {startBullmqWorker} from '../src/worker.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe.skipIf(!enabled)('quota groups under BullMQ',()=>{
 it('refuse a call without a quota group or rules before reserving, and fail one whose binding was removed after acceptance at once',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,installation=id('quota-ready'),fixture=await seedLoadFixture(pool,1),api=createApi(pool);
  const connection=(await pool.query("SELECT id FROM provider_connections WHERE organization_id=$1",[fixture.scope.organization_id])).rows[0].id;
  const group=async(model:string)=>(await pool.query('SELECT group_id FROM provider_quota_bindings WHERE connection_id=$1 AND model=$2',[connection,model])).rows[0]?.group_id;
  const invoke=(profile:'text.standard'|'image.standard')=>api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile,
   ...(profile==='text.standard'?{input:{text:'Quota readiness'},parameters:{max_output_tokens:100}}:{input:{prompt:'Quota readiness'},parameters:{count:1,size:'1024x1024',quality:'standard'}})}});
  const operations=async()=>(await pool.query('SELECT count(*)::int AS n FROM operations WHERE account_id=$1',[fixture.scope.account_id])).rows[0].n;
  const reserved=async()=>(await transaction(pool,tx=>getWallet(tx,fixture.scope,systemClock))).reserved_units;

  // No group for the image model: refused with the pair named, nothing reserved.
  const imageGroup=await group('fake-image');
  await pool.query('DELETE FROM provider_quota_bindings WHERE connection_id=$1 AND model=$2',[connection,'fake-image']);
  const noGroup=await invoke('image.standard');
  expect(noGroup.statusCode).toBe(409);
  expect(noGroup.json().error).toMatchObject({code:'quota_group_missing',details:{connection_id:connection,model:'fake-image'}});
  // A group without rules is as useless.
  const textGroup=await group('fake-text');
  const rules=(await pool.query('SELECT key,metric,capacity,window_ms FROM provider_quota_rules WHERE group_id=$1',[textGroup])).rows;
  await pool.query('DELETE FROM provider_quota_rules WHERE group_id=$1',[textGroup]);
  const noRules=await invoke('text.standard');
  expect(noRules.statusCode).toBe(409);
  expect(noRules.json().error).toMatchObject({code:'quota_rules_missing',details:{connection_id:connection,model:'fake-text',group_id:textGroup}});
  expect(await operations()).toBe(0);expect(await reserved()).toBe('0');

  // The check belongs to BullMQ: the legacy backend takes the same call.
  vi.stubEnv('UAI_EXECUTION_BACKEND','legacy');
  const legacy=await invoke('image.standard');
  expect(legacy.statusCode,legacy.body).toBe(202);
  await pool.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE id=$1",[legacy.json().request_id]);
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');

  // Accepted with a complete configuration, then the binding is removed before the worker takes the call.
  for(const rule of rules)await pool.query('INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,$2,$3,$4,$5)',[textGroup,rule.key,rule.metric,rule.capacity,rule.window_ms]);
  const before=await reserved(),accepted=await invoke('text.standard');
  expect(accepted.statusCode,accepted.body).toBe(202);
  expect(BigInt(await reserved())).toBeGreaterThan(BigInt(before));
  const {request_id,operation_id}=accepted.json();
  await pool.query('DELETE FROM provider_quota_bindings WHERE connection_id=$1 AND model=$2',[connection,'fake-text']);
  const deps=defaultRuntime(pool),base=deps.adapter;let sent=0;
  deps.adapter=async(...args)=>{const adapter=await base(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(input,context)=>{sent++;return execute(input,context)};return adapter};
  const scheduler=startScheduler({pool,backend:'bullmq',installation,redisUrl:process.env.REDIS_URL!,intervalMs:100});
  const worker=startBullmqWorker({pool,installation,redisUrl:process.env.REDIS_URL!,deps,name:'quota-ready',queues:['text','maintenance'],concurrency:2,heartbeatMs:60000,maintenance:{interval_ms:200,idle_interval_ms:200}});
  const started=Date.now();
  try{
   await expect.poll(async()=>(await pool.query('SELECT execution_status,reason,financial_closed_at FROM execution_requests WHERE id=$1',[request_id])).rows[0],{timeout:10000,interval:50})
    .toMatchObject({execution_status:'failed',reason:'quota_group_missing',financial_closed_at:expect.any(Date)});
   // Far sooner than the hour-long deadline, and never sent.
   expect(Date.now()-started).toBeLessThan(5000);expect(sent).toBe(0);
   const reservation=await transaction(pool,tx=>getReservation(tx,fixture.scope,operation_id));
   expect(reservation.captured_units).toBe('0');expect(reservation.claims.every((claim:any)=>claim.status!=='open')).toBe(true);
   expect(await reserved()).toBe(before);
   expect(imageGroup).toBeTruthy();
  }finally{await worker.close();await scheduler.stop()}
 },40000);
});
