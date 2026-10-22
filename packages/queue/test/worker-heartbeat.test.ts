import type {PoolClient} from 'pg';
import {fork,type ChildProcess} from 'node:child_process';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id,ManualClock} from '../../contracts/src/index.js';
import {transaction} from '../../db/src/index.js';
import {issueToken} from '../../auth/src/index.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';
import {ExecutionTransport} from '../src/transport.js';
import {writeWorkerHeartbeat} from '../src/worker-heartbeat.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());
describe.skipIf(!enabled)('worker heartbeat lifecycle',()=>{
 it('reports a real worker busy while blocked, draining, stopped and expired after SIGKILL',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,installation=id('health'),fixture=await seedLoadFixture(pool,1),api=createApi(pool),transport=new ExecutionTransport(installation,process.env.REDIS_URL!);
  let child:ChildProcess|undefined;const errors:string[]=[];let blocker:PoolClient|undefined;
  const spawn=()=>{child=fork(new URL('../../../apps/worker/src/index.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:database.url,UAI_WORKER_BACKEND:'bullmq',UAI_WORKER_QUEUES:'text,image',UAI_WORKER_CONCURRENCY:'2',UAI_INSTALLATION_ID:installation,UAI_VAULT_KEY_FILE:'/tmp/uai-no-vault-key-for-heartbeat-test'},stdio:['ignore','ignore','pipe','ipc']});child.stderr?.on('data',data=>errors.push(String(data)));return child};
  const rows=async()=>(await pool.query('SELECT * FROM execution_worker_heartbeats WHERE installation_id=$1 ORDER BY worker_id,queue_kind',[installation])).rows;
  try{
   vi.stubEnv('UAI_INSTALLATION_ID',installation);
   const liveAdmin=await transaction(pool,tx=>issueToken(tx,{...fixture.scope,account_ids:null,scopes:['operations:admin'],max_grant_units:null,expires_at:null}));
   const health=async()=>{const result=await api.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${liveAdmin.token}`}});expect(result.statusCode,result.body).toBe(200);return result.json().workers.data.find((q:any)=>q.queue_kind==='text')};
   const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invoke')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Worker heartbeat test'},parameters:{max_output_tokens:100}}});
   expect(response.statusCode,response.body).toBe(202);const request=response.json();
   spawn();await expect.poll(async()=>(await rows()).length,{timeout:10000}).toBe(2);
   expect((await rows()).map(r=>[r.queue_kind,r.state,r.concurrency,r.active_jobs])).toEqual([['image','running',2,0],['text','running',2,0]]);
   blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query("SELECT queue_kind FROM execution_dispatch_policies WHERE queue_kind='text' FOR UPDATE");
   await transport.publish('text',{request_id:request.request_id,generation:0,purpose:'execute'});
   await expect.poll(async()=>(await rows()).find(r=>r.queue_kind==='text')?.active_jobs,{timeout:15000}).toBe(1);
   expect(await health()).toMatchObject({alive_workers:1,draining_workers:0,stale_workers:0,configured_concurrency:2,active_jobs:1});
   const exited=new Promise(resolve=>child!.once('exit',(code,signal)=>resolve({code,signal})));
   child!.kill('SIGTERM');await expect.poll(async()=>(await rows()).find(r=>r.queue_kind==='text')?.state,{timeout:5000}).toBe('draining');
   expect(await health()).toMatchObject({alive_workers:1,draining_workers:1,stale_workers:0,configured_concurrency:0,active_jobs:1});
   await blocker.query('ROLLBACK');blocker.release();blocker=undefined;
   expect(await exited).toEqual({code:0,signal:null});
   expect((await rows()).every(r=>r.state==='stopped'&&r.active_jobs===0)).toBe(true);
   const measured=(await rows()).find(r=>r.queue_kind==='text').telemetry;expect(measured.admission_ms).toHaveLength(1);expect(measured.admission_ms[0]).toBeGreaterThanOrEqual(0);expect(measured.db.state).toBe('ok');expect(measured.redis.state).toBe('ok');
   expect((await pool.query('SELECT execution_status,attempt_count FROM execution_requests WHERE id=$1',[request.request_id])).rows[0]).toEqual({execution_status:'succeeded',attempt_count:1});
   spawn();await expect.poll(async()=>(await rows()).filter(r=>r.state==='running').length,{timeout:10000}).toBe(2);
   const killed=new Promise(resolve=>child!.once('exit',(code,signal)=>resolve({code,signal})));child!.kill('SIGKILL');expect(await killed).toEqual({code:null,signal:'SIGKILL'});
   const admin=await transaction(pool,tx=>issueToken(tx,{...fixture.scope,account_ids:null,scopes:['operations:admin'],max_grant_units:null,expires_at:null}));
   vi.stubEnv('UAI_INSTALLATION_ID',installation);
   const clock=new ManualClock(new Date(Date.now()+46000)),readApi=createApi(pool,clock);
   // Another installation must never inflate the configured capacity.
   await writeWorkerHeartbeat(pool,id('other-installation'),'other','running',[{queue_kind:'text',concurrency:100,active_jobs:0}]);
   try{
    const live=await readApi.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${admin.token}`}});expect(live.json().workers.data.find((q:any)=>q.queue_kind==='text').alive_workers).toBe(1);
    // Age only this killed process's telemetry; API clock skew alone must not mark it stale.
    await pool.query("UPDATE execution_worker_heartbeats SET heartbeat_at=clock_timestamp()-interval '46 seconds' WHERE installation_id=$1 AND state='running'",[installation]);
    const result=await readApi.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${admin.token}`}});expect(result.statusCode,result.body).toBe(200);
    expect(result.json().workers.data.find((q:any)=>q.queue_kind==='text')).toMatchObject({queue_kind:'text',alive_workers:0,draining_workers:0,stale_workers:1,configured_concurrency:0,active_jobs:0});
    await pool.query("UPDATE execution_worker_heartbeats SET heartbeat_at=clock_timestamp()-interval '25 hours' WHERE installation_id=$1",[installation]);const expired=await readApi.inject({method:'GET',url:'/v1/admin/execution-metrics',headers:{authorization:`Bearer ${admin.token}`}});expect(expired.json().workers.data.every((q:any)=>q.stale_workers===0)).toBe(true);
   }finally{await readApi.close()}
   expect(errors).toEqual([]);
  }finally{
   if(blocker){await blocker.query('ROLLBACK');blocker.release()}
   if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGKILL');await exited}
   await transport.queue('text').obliterate({force:true});await transport.queue('image').obliterate({force:true});await transport.close();await api.close();vi.unstubAllEnvs();
  }
 },45000);
});
