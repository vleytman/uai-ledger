import {execFile,fork,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:net';
import {promisify} from 'node:util';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {leaseNext,configureBudget} from '../../execution/src/index.js';
import {CatalogService} from '../../catalog/src/index.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {publishRecipe} from '../../quoting/src/index.js';
import {ExecutionTransport} from '../src/transport.js';
import {providerAdmission} from '../src/provider-admission.js';
import {previewBackendTransition,transitionRequestBackend,type ExecutionBackend} from '../src/backend-transition.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL);
const enabled=!!process.env.DATABASE_URL&&!!process.env.REDIS_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());
const actor={actor_id:'test',reason:'Isolated backend transition acceptance'};
async function fixture(){
 vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
 const pool=database.pool!,f=await seedLoadFixture(pool,1),api=createApi(pool);
 const installation=id('transition'),transport=new ExecutionTransport(installation,process.env.REDIS_URL!),broker=providerAdmission(pool,process.env.REDIS_URL!,installation);
 const deps=defaultRuntime(pool),base=deps.adapter;let calls=0;
 deps.onDelta=undefined;deps.adapter=async(...args)=>{const adapter=await base(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(...args)=>{calls++;return execute(...args)};return adapter};
 const invoke=async()=>{
  const result=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':id('invoke')},payload:{priority:'interactive',account_id:f.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Backend transition fixture'},parameters:{max_output_tokens:100}}});
  expect(result.statusCode,result.body).toBe(202);return result.json() as {request_id:string;operation_id:string};
 };
 return {...f,pool,api,transport,broker,deps,invoke,calls:()=>calls,
  move:(request_id:string,from:ExecutionBackend,to:ExecutionBackend,generation:number)=>transaction(pool,tx=>transitionRequestBackend(tx,f.scope,systemClock,{request_id,from,to,generation},actor)),
  runtime:{...deps,admit:broker.admit,onRateLimits:broker.onRateLimits,onProviderResult:broker.onProviderResult,renewAdmission:broker.renewAdmission},
  async close(){await transport.close();const cleanup=new ExecutionTransport(installation,process.env.REDIS_URL!);await cleanup.queue('text').obliterate({force:true});await cleanup.close();await broker.close();await api.close();vi.unstubAllEnvs()}
 };
}
describe.skipIf(!enabled)('Guarded backend transition',()=>{
 it('switches new admissions across separate API processes and drains requests with their persisted backend',async()=>{
  const f=await fixture(),children:ChildProcess[]=[],errors:string[]=[],pids:number[]=[];
  const stop=async(child:ChildProcess)=>{
   if(child.exitCode!==null||child.signalCode!==null)return;
   const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
   child.kill('SIGTERM');expect(await exited).toEqual({code:0,signal:null});
  };
  const start=async(backend:ExecutionBackend)=>{
   const socket=createServer();await new Promise<void>(resolve=>socket.listen(0,'127.0.0.1',resolve));
   const port=(socket.address() as {port:number}).port;await new Promise<void>(resolve=>socket.close(()=>resolve()));
   const child=fork(new URL('../../../apps/api/src/index.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:database.url,UAI_HOST:'127.0.0.1',UAI_PORT:String(port),UAI_EXECUTION_BACKEND:backend,UAI_ALLOW_REAL_PROVIDERS:'false',UAI_BLOB_BACKEND:'local'},stdio:['ignore','ignore','pipe','ipc']});
   children.push(child);pids.push(child.pid!);child.on('error',error=>errors.push(error.message));child.stderr?.on('data',chunk=>errors.push(String(chunk)));
   const address=`http://127.0.0.1:${port}`;
   await vi.waitFor(async()=>{expect(child.exitCode).toBeNull();expect((await fetch(address+'/health')).status).toBe(200)},{timeout:10000});
   return {child,address};
  };
  const invoke=async(address:string)=>{
   const response=await fetch(address+'/v1/invocations',{method:'POST',headers:{authorization:`Bearer ${f.token}`,'content-type':'application/json','idempotency-key':id('process-cutover')},body:JSON.stringify({account_id:f.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Separate API process cutover'},parameters:{max_output_tokens:100}})});
   expect(response.status).toBe(202);return await response.json() as {request_id:string;operation_id:string};
  };
  try{
   const first=await start('legacy'),old=await invoke(first.address);await stop(first.child);
   const before=(await f.pool.query('SELECT route,max_units FROM execution_requests WHERE id=$1',[old.request_id])).rows[0];
   const second=await start('bullmq'),fresh=await invoke(second.address);await stop(second.child);
   const third=await start('legacy'),rollback=await invoke(third.address);await stop(third.child);
   expect(new Set(pids).size).toBe(3);
   for(const [request,backend] of [[old,'legacy'],[fresh,'bullmq'],[rollback,'legacy']] as const){
    expect((await f.pool.query('SELECT execution_backend FROM execution_requests WHERE id=$1',[request.request_id])).rows[0].execution_backend).toBe(backend);
    const deps=backend==='bullmq'?{...f.runtime,limits:{backend,generation:0}}:{...f.deps,limits:{backend,scope:f.scope}};
    expect(await executeRequest(f.pool,deps,request.request_id)).toMatchObject({state:'succeeded'});
   }
   expect((await f.pool.query('SELECT route,max_units FROM execution_requests WHERE id=$1',[old.request_id])).rows[0]).toEqual(before);
   expect((await f.pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=ANY($1::text[])',[[old.request_id,fresh.request_id,rollback.request_id]])).rows).toEqual(Array.from({length:3},()=>({execution_status:'succeeded',settlement_status:'settled',attempt_count:1})));
   expect(f.calls()).toBe(3);expect(errors).toEqual([]);
  }finally{for(const child of children)await stop(child);await f.close()}
 },30000);
 it('keeps accepted routes and prices while a new recipe sends new work to a different connection',async()=>{
  const f=await fixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  let activeRun:ReturnType<typeof executeRequest>|undefined,started=false;
  try{
   const pending=await f.invoke(),active=await f.invoke();
   const terms=async()=>({requests:(await f.pool.query('SELECT id,route,max_units FROM execution_requests WHERE id=ANY($1::text[]) ORDER BY id',[[pending.request_id,active.request_id]])).rows,quotes:(await f.pool.query('SELECT q.* FROM quotes q JOIN operations o ON o.quote_id=q.id WHERE o.id=ANY($1::text[]) ORDER BY q.id',[[pending.operation_id,active.operation_id]])).rows});
   const before=await terms(),oldConnection=before.requests[0].route.primary.connection_id;
   const calls:string[]=[],runtime={...f.runtime,limits:{backend:'bullmq' as const,generation:0},adapter:async(...args:Parameters<typeof f.deps.adapter>)=>{
    const adapter=await f.deps.adapter(...args),execute=adapter.execute.bind(adapter);
    adapter.execute=async(...input)=>{calls.push(args[1].connection_id);return execute(...input)};return adapter;
   }};
   const activeRuntime={...runtime,adapter:async(...args:Parameters<typeof f.deps.adapter>)=>{const adapter=await runtime.adapter(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(...input)=>{started=true;await gate;return execute(...input)};return adapter}};
   activeRun=executeRequest(f.pool,activeRuntime,active.request_id);
   await vi.waitFor(()=>expect(started).toBe(true));
   const connection=await transaction(f.pool,async tx=>{
    const old=(await tx.query('SELECT * FROM provider_connections WHERE id=$1',[oldConnection])).rows[0];
    const next=await new ConnectionService(tx,systemClock).create(f.scope,{...old,name:'Replacement synthetic connection'},actor);
    await configureBudget(tx,f.scope,'provider',next.id,'100000000000');
    await tx.query('INSERT INTO provider_quota_bindings(connection_id,model,group_id) SELECT $1,model,group_id FROM provider_quota_bindings WHERE connection_id=$2',[next.id,oldConnection]);
    const recipe=(await tx.query("SELECT definition FROM recipe_versions WHERE organization_id=$1 AND application_id=$2 AND key='text.standard' ORDER BY version DESC LIMIT 1",[f.scope.organization_id,f.scope.application_id])).rows[0].definition;
    const catalog=new CatalogService(tx,systemClock),oldRoute=await catalog.get(f.scope,recipe.components[0].route_version_id);
    const payload=oldRoute.payload as any;
    const route=await catalog.createDraft(f.scope,{kind:'route',key:oldRoute.key,version:2,payload:{...payload,primary:{...payload.primary,connection_id:next.id}},author:'test',comment:'Route replacement during active work'});
    await catalog.publish(f.scope,route.id,route.revision);
    await publishRecipe(tx,f.scope,systemClock,{...recipe,version:2,components:recipe.components.map((component:any)=>({...component,route_version_id:route.id}))});
    return next;
   });
   const fresh=await f.invoke();
   expect((await f.pool.query('SELECT route FROM execution_requests WHERE id=$1',[fresh.request_id])).rows[0].route.primary.connection_id).toBe(connection.id);
   expect(await terms()).toEqual(before);
   const completed:string[]=[],errors:string[]=[];
   f.transport.consume('text',1,async delivery=>{const result=await executeRequest(f.pool,runtime,delivery.request_id);expect(result).toMatchObject({state:'succeeded'});completed.push(delivery.request_id);return result},error=>errors.push(error.message));
   for(const request of [pending,fresh])await f.transport.publish('text',{request_id:request.request_id,generation:0,purpose:'execute'});
   await vi.waitFor(()=>expect(completed).toHaveLength(2),{timeout:10000});
   release();expect(await activeRun).toMatchObject({state:'succeeded'});
   expect((await f.pool.query('SELECT execution_status,reason FROM execution_requests WHERE id=$1',[fresh.request_id])).rows[0]).toEqual({execution_status:'succeeded',reason:null});
   expect(errors).toEqual([]);expect(calls.filter(value=>value===oldConnection)).toHaveLength(2);expect(calls.filter(value=>value===connection.id)).toHaveLength(1);
   expect(await terms()).toEqual(before);
   expect((await f.pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=ANY($1::text[])',[[pending.request_id,active.request_id,fresh.request_id]])).rows).toEqual(Array.from({length:3},()=>({execution_status:'succeeded',settlement_status:'settled',attempt_count:1})));
  }finally{release();await activeRun?.catch(()=>{});await f.close()}
 });
 it('cuts API admission over and back while draining active legacy work and retaining unknown outcomes',async()=>{
  const f=await fixture();let switched:ReturnType<typeof createApi>|undefined,rolledBack:ReturnType<typeof createApi>|undefined;
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve});
  let activeRun:ReturnType<typeof executeRequest>|undefined;
  const call=async(api:ReturnType<typeof createApi>)=>{const r=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':id('cutover')},payload:{priority:'interactive',account_id:f.scope.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:'Controlled cutover'},parameters:{max_output_tokens:100}}});expect(r.statusCode,r.body).toBe(202);return r.json() as {request_id:string;operation_id:string}};
  try{
   vi.stubEnv('UAI_EXECUTION_BACKEND','legacy');
   const pending=await f.invoke(),active=await f.invoke(),unknown=await f.invoke();
   const activeRuntime={...f.deps,limits:{backend:'legacy' as const,scope:f.scope},adapter:async(...args:Parameters<typeof f.deps.adapter>)=>{const adapter=await f.deps.adapter(...args),execute=adapter.execute.bind(adapter);adapter.execute=async(...args)=>{entered();await gate;return execute(...args)};return adapter}};
   activeRun=executeRequest(f.pool,activeRuntime,active.request_id);await started;
   const unknownRuntime={...f.deps,limits:{backend:'legacy' as const,scope:f.scope},adapter:async(...args:Parameters<typeof f.deps.adapter>)=>{const adapter=await f.deps.adapter(...args);adapter.execute=async()=>({outcome:'unknown' as const,failure:{kind:'unknown' as const,code:'synthetic_timeout',sent:true},usage:{state:'unknown' as const,reason:'synthetic_timeout'}});return adapter}};
   expect(await executeRequest(f.pool,unknownRuntime,unknown.request_id)).toMatchObject({state:'outcome_unknown'});
   const unknownBefore=(await f.pool.query('SELECT * FROM reservations WHERE operation_id=$1',[unknown.operation_id])).rows;
   await f.api.close();vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');switched=createApi(f.pool);
   const fresh=await call(switched);
   expect((await f.pool.query('SELECT execution_backend FROM execution_requests WHERE id=$1',[fresh.request_id])).rows[0].execution_backend).toBe('bullmq');
   await expect(f.move(active.request_id,'legacy','bullmq',0)).rejects.toMatchObject({code:'backend_transition_unsafe'});
   await expect(f.move(unknown.request_id,'legacy','bullmq',0)).rejects.toMatchObject({code:'backend_transition_unsafe'});
   await f.move(pending.request_id,'legacy','bullmq',0);
   const completed:string[]=[],workerErrors:string[]=[];
   f.transport.consume('text',2,async delivery=>{const result=await executeRequest(f.pool,{...f.runtime,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id);completed.push(delivery.request_id);return result},error=>workerErrors.push(error.message));
   await f.transport.publish('text',{request_id:pending.request_id,generation:1,purpose:'execute'});
   await f.transport.publish('text',{request_id:fresh.request_id,generation:0,purpose:'execute'});
   // This checks eventual delivery across processes, not a one-second latency SLO.
   await expect.poll(()=>completed.length,{timeout:10000}).toBe(2);expect(workerErrors).toEqual([]);
   release();expect(await activeRun).toMatchObject({state:'succeeded'});
   await switched.close();vi.stubEnv('UAI_EXECUTION_BACKEND','legacy');rolledBack=createApi(f.pool);
   const afterRollback=await call(rolledBack);
   expect((await f.pool.query('SELECT execution_backend FROM execution_requests WHERE id=$1',[afterRollback.request_id])).rows[0].execution_backend).toBe('legacy');
   expect(await executeRequest(f.pool,{...f.deps,limits:{backend:'legacy',scope:f.scope}},afterRollback.request_id)).toMatchObject({state:'succeeded'});
   const ids=[pending.request_id,active.request_id,fresh.request_id,afterRollback.request_id];
   expect((await f.pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=ANY($1::text[])',[ids])).rows).toEqual(ids.map(()=>({execution_status:'succeeded',settlement_status:'settled',attempt_count:1})));
   expect((await f.pool.query('SELECT * FROM reservations WHERE operation_id=$1',[unknown.operation_id])).rows).toEqual(unknownBefore);
   expect((await f.pool.query('SELECT execution_backend,execution_status,attempt_count FROM execution_requests WHERE id=$1',[unknown.request_id])).rows[0]).toMatchObject({execution_backend:'legacy',execution_status:'outcome_unknown',attempt_count:1});
  }finally{release();await activeRun?.catch(()=>{});await switched?.close();await rolledBack?.close();await f.close()}
 });
 it('invalidates published jobs across a round trip, preserves accepted terms, then charges exactly once',async()=>{
  const f=await fixture();try{
   const r=await f.invoke();
   const immutable=async()=>({request:(await f.pool.query('SELECT route,input_hash,input_ref,max_units,deadline_at,not_before FROM execution_requests WHERE id=$1',[r.request_id])).rows[0],reservation:(await f.pool.query('SELECT * FROM reservations WHERE operation_id=$1',[r.operation_id])).rows,quote:(await f.pool.query('SELECT q.* FROM quotes q JOIN operations o ON o.quote_id=q.id WHERE o.id=$1',[r.operation_id])).rows});
   const before=await immutable();
   expect(await previewBackendTransition(f.pool,f.scope,systemClock,r.request_id)).toMatchObject({eligible:true,backend:'bullmq',generation:0});
   await f.transport.publish('text',{request_id:r.request_id,generation:0,purpose:'execute'});
   expect(await f.move(r.request_id,'bullmq','legacy',0)).toMatchObject({backend:'legacy',generation:1});
   expect(await executeRequest(f.pool,{...f.runtime,limits:{backend:'bullmq',generation:0}},r.request_id)).toEqual({worked:false});
   expect(await f.move(r.request_id,'legacy','bullmq',1)).toMatchObject({backend:'bullmq',generation:2});
   expect(await immutable()).toEqual(before);expect(f.calls()).toBe(0);
   await expect(f.move(r.request_id,'legacy','bullmq',1)).rejects.toMatchObject({code:'revision_conflict'});
   await f.transport.publish('text',{request_id:r.request_id,generation:2,purpose:'execute'});
   const handled:number[]=[],errors:string[]=[];
   const worker=f.transport.consume('text',2,async delivery=>{const result=await executeRequest(f.pool,{...f.runtime,limits:{backend:'bullmq',generation:delivery.generation}},delivery.request_id);if(delivery.generation===0)expect(result).toEqual({worked:false});handled.push(delivery.generation);return result},error=>errors.push(error.message));
   worker.on('failed',(_job,error)=>errors.push(error.message));
   await expect.poll(()=>handled.length).toBe(2);expect(errors).toEqual([]);expect(f.calls()).toBe(1);
   const result=(await f.pool.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=$1',[r.request_id])).rows[0];
   expect(result).toEqual({execution_status:'succeeded',settlement_status:'settled',attempt_count:1});
   expect(BigInt((await f.pool.query('SELECT captured_units FROM reservations WHERE operation_id=$1',[r.operation_id])).rows[0].captured_units)).toBeGreaterThan(0n);
   expect((await f.pool.query("SELECT count(*)::int n FROM audit_events WHERE resource_id=$1 AND action='execution.backend.transferred'",[r.request_id])).rows[0].n).toBe(2);
  }finally{await f.close()}
 });
 it('allows a pending rollback to execute once on legacy and refuses submitted or unknown requests',async()=>{
  const f=await fixture();try{
   const r=await f.invoke();await f.move(r.request_id,'bullmq','legacy',0);
   expect(await executeRequest(f.pool,{...f.deps,limits:{backend:'legacy',scope:f.scope}},r.request_id)).toMatchObject({state:'succeeded'});
   expect(f.calls()).toBe(1);await expect(f.move(r.request_id,'legacy','bullmq',1)).rejects.toMatchObject({code:'backend_transition_unsafe',message:'request_already_attempted'});
   const unknown=await f.invoke(),runtime={...f.runtime};
   runtime.adapter=async(...args)=>{const adapter=await f.deps.adapter(...args);adapter.execute=async()=>({outcome:'unknown',failure:{kind:'unknown',code:'synthetic_timeout',sent:true},usage:{state:'unknown',reason:'synthetic_timeout'}});return adapter};
   expect(await executeRequest(f.pool,{...runtime,limits:{backend:'bullmq',generation:0}},unknown.request_id)).toMatchObject({state:'outcome_unknown'});
   const before=(await f.pool.query('SELECT * FROM reservations WHERE operation_id=$1',[unknown.operation_id])).rows;
   await expect(f.move(unknown.request_id,'bullmq','legacy',0)).rejects.toMatchObject({code:'backend_transition_unsafe'});
   expect((await f.pool.query('SELECT * FROM reservations WHERE operation_id=$1',[unknown.operation_id])).rows).toEqual(before);
   expect((await f.pool.query('SELECT execution_backend,attempt_count FROM execution_requests WHERE id=$1',[unknown.request_id])).rows[0]).toEqual({execution_backend:'bullmq',attempt_count:1});
  }finally{await f.close()}
 });
 it('CLI defaults to preview and requires an explicit matching revision for apply',async()=>{
  const f=await fixture();try{
   const r=await f.invoke(),exec=promisify(execFile);
   const args=['--import','tsx','scripts/transition-request-backend.ts','--organization',f.scope.organization_id,'--application',f.scope.application_id,'--account',f.scope.account_id,'--request',r.request_id];
   const options={env:{...process.env,DATABASE_URL:database.url},timeout:10000};
   expect(JSON.parse((await exec(process.execPath,args,options)).stdout)).toMatchObject({mode:'preview',backend:'bullmq',generation:0,eligible:true});
   expect((await previewBackendTransition(f.pool,f.scope,systemClock,r.request_id)).generation).toBe(0);
   const apply=[...args,'--apply','--from','bullmq','--to','legacy','--generation','0','--actor','cli-test','--reason','Test rollback'];
   expect(JSON.parse((await exec(process.execPath,apply,options)).stdout)).toMatchObject({mode:'applied',backend:'legacy',generation:1});
   await expect(exec(process.execPath,apply,options)).rejects.toMatchObject({code:1,stderr:expect.stringContaining('revision_conflict')});
   expect((await previewBackendTransition(f.pool,f.scope,systemClock,r.request_id)).generation).toBe(1);
   expect(f.calls()).toBe(0);
  }finally{await f.close()}
 });
 it.each(['bullmq','legacy'] as const)('serializes transfer against %s leasing and respects account scope',async from=>{
  const f=await fixture();try{
   const r=await f.invoke();
   await expect(transaction(f.pool,tx=>transitionRequestBackend(tx,{...f.scope,account_id:'foreign'},systemClock,{request_id:r.request_id,from:'bullmq',to:'legacy',generation:0},actor))).rejects.toMatchObject({code:'not_found'});
   const generation=from==='legacy'?1:0,to=from==='legacy'?'bullmq':'legacy';
   if(from==='legacy')await f.move(r.request_id,'bullmq','legacy',0);
   const results=await Promise.allSettled([
    f.move(r.request_id,from,to,generation),
    transaction(f.pool,tx=>leaseNext(tx,systemClock,'racing-worker',{backend:from,generation,scope:f.scope},undefined,r.request_id,true)),
   ]);
   const row=(await f.pool.query('SELECT execution_backend,execution_status FROM execution_requests WHERE id=$1',[r.request_id])).rows[0];
   if(results[0].status==='fulfilled'){
    expect(results[1]).toMatchObject({status:'fulfilled',value:null});expect(row).toEqual({execution_backend:to,execution_status:'queued'});
   }else{
    expect(results[0].reason).toMatchObject({code:'backend_transition_unsafe'});expect(results[1].status).toBe('fulfilled');expect(row).toEqual({execution_backend:from,execution_status:'leased'});
   }
   expect(f.calls()).toBe(0);
  }finally{await f.close()}
 });
});
