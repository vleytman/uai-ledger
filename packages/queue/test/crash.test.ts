import {createServer,type Server} from 'node:http';
import {fork,type ChildProcess} from 'node:child_process';
import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {createPool,transaction} from '../../db/src/index.js';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {createApi} from '../../../apps/api/src/server.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {defaultRuntime} from '../../execution/src/default-runtime.js';
import {executeRequest} from '../../execution/src/runtime.js';
import {recoverExpiredLeases} from '../../execution/src/index.js';
import {ExecutionTransport} from '../src/transport.js';

const sourceUrl=process.env.DATABASE_URL;
const database=isolatedTestDatabase(sourceUrl);
let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{
 if(!sourceUrl||!process.env.REDIS_URL)return;
 await database.initialize();pool=database.pool;
});
afterAll(()=>database.close());
describe.skipIf(!sourceUrl||!process.env.REDIS_URL)('worker process crash',()=>{
 for(const scenario of ['before-provider','http-accepted','http-body','submitted','result','settled','stalled'])it(`does not repeat generation after SIGKILL at ${scenario}, recovery and ${scenario==='stalled'?'automatic stalled redelivery':'duplicate BullMQ delivery'}`,async()=>{
  const boundary=scenario==='stalled'?'submitted':scenario;
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const installation=`crash_${id('test')}`,transport=new ExecutionTransport(installation,process.env.REDIS_URL!);
  const api=createApi(pool!),fixture=await seedLoadFixture(pool!,1);
  let child:ChildProcess|undefined,http:Server|undefined,httpEndpoint:string|undefined;
  const httpCalls:string[]=[];
  const messages:any[]=[],faults:string[]=[];
  try{
   if(boundary==='http-body'||boundary==='http-accepted'){
    http=createServer((request,response)=>{
     let body='';request.setEncoding('utf8');request.on('data',chunk=>{body+=chunk});
     request.on('end',()=>{httpCalls.push(body);if(boundary==='http-accepted'){messages.push({type:'http-accepted'});return}response.writeHead(200,{'content-type':'application/json'});response.write('{"result":');});
    });
    await new Promise<void>(resolve=>http!.listen(0,'127.0.0.1',resolve));
    httpEndpoint=`http://127.0.0.1:${(http.address() as {port:number}).port}/synthetic`;
   }
   const response=await api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${fixture.token}`,'idempotency-key':id('invocation')},payload:{account_id:fixture.scope.account_id,budget:{max_units:'24000000'},profile:'image.standard',input:{prompt:'Synthetic crash boundary'},parameters:{count:1,size:'1024x1024',quality:'standard'}}});
   expect(response.statusCode).toBe(202);
   const {request_id,operation_id}=response.json();
   child=fork(new URL('./fixtures/crash-worker.ts',import.meta.url),[],{execArgv:['--import','tsx'],env:{...process.env,DATABASE_URL:database.url,UAI_CRASH_TEST_ONLY:'1',UAI_CRASH_BOUNDARY:boundary,UAI_INSTALLATION_ID:installation,...(httpEndpoint?{UAI_CRASH_HTTP_ENDPOINT:httpEndpoint}:{})},stdio:['ignore','ignore','pipe','ipc']});
   child.on('message',message=>messages.push(message));child.on('error',error=>faults.push(error.message));child.stderr?.on('data',chunk=>faults.push(String(chunk)));
   await vi.waitFor(()=>expect(messages.some(m=>m.type==='ready')).toBe(true),{timeout:10000});
   const delivery={request_id,generation:0,purpose:'execute' as const};
   await transport.publish('image',delivery);
   await vi.waitFor(()=>expect(messages.some(m=>m.type===boundary)).toBe(true),{timeout:10000});
   expect(messages.filter(m=>m.type==='provider-called')).toHaveLength(boundary==='before-provider'?0:1);
   const attempt=(await pool!.query('SELECT id,submission_intent_at,status FROM execution_attempts WHERE request_id=$1',[request_id])).rows[0];
   expect(attempt).toMatchObject({submission_intent_at:expect.any(Date),status:boundary==='settled'?'succeeded':'submitting'});
   if(boundary==='result')expect((await pool!.query("SELECT result->>'outcome' AS outcome FROM quota_result_feedback WHERE attempt_id=$1",[attempt.id])).rows).toEqual([{outcome:'success'}]);
   if(boundary==='http-body'||boundary==='http-accepted'){expect(httpCalls).toHaveLength(1);expect(JSON.parse(httpCalls[0]!)).toEqual({attempt_id:attempt.id});if(boundary==='http-body')expect(messages.find(m=>m.type==='http-body').status).toBe(200)}
   const capturedBefore=(await pool!.query('SELECT captured_units FROM reservations WHERE operation_id=$1',[operation_id])).rows[0].captured_units;
   const exited=new Promise(resolve=>child!.once('exit',(code,signal)=>resolve({code,signal})));
   child.kill('SIGKILL');expect(await exited).toEqual({code:null,signal:'SIGKILL'});
   // Advance only this request's durable expiry, without waiting 30 seconds or altering other tests.
   await pool!.query("UPDATE execution_requests SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[request_id]);
   expect(await transaction(pool!,tx=>recoverExpiredLeases(tx,systemClock,fixture.scope))).toBe(boundary==='settled'?0:1);
   if(boundary==='submitted'||boundary==='before-provider'||boundary==='http-body'||boundary==='http-accepted')expect((await pool!.query("SELECT slot_released_at IS NULL AS held,slot_expires_at>now() AS live FROM dispatch_admissions WHERE request_id=$1 AND state='admitted'",[request_id])).rows).toEqual([{held:true,live:true}]);
   let providerCalls=0,duplicateHandled=false;
   const deps=defaultRuntime(pool!);deps.adapter=async()=>{providerCalls++;throw new Error('unknown must not execute')};
   const worker=transport.consume('image',1,async duplicate=>{
    expect(await executeRequest(pool!,{...deps,limits:{backend:'bullmq',generation:duplicate.generation}},duplicate.request_id)).toEqual({worked:false});
    duplicateHandled=true;
   },error=>faults.push(error.message));
   const stalled:string[]=[];worker.on('stalled',jobId=>stalled.push(jobId));
   if(scenario!=='stalled'){
    // Deliberately bypass job-ID deduplication to test the durable permission boundary.
    await transport.queue('image').add('duplicate',delivery,{jobId:id('duplicate')});
   }
   // The stalled case waits for BullMQ's real lock expiry and stalled scan. No manual requeue.
   await vi.waitFor(()=>expect(duplicateHandled).toBe(true),{timeout:scenario==='stalled'?70000:5000});
   if(scenario==='stalled')expect(stalled).toHaveLength(1);
   if(boundary==='http-body'||boundary==='http-accepted')expect(httpCalls).toHaveLength(1);
   expect(providerCalls).toBe(0);expect(messages.filter(m=>m.type===boundary)).toHaveLength(1);expect(faults).toEqual([]);
   const request=(await pool!.query('SELECT execution_status,settlement_status,attempt_count FROM execution_requests WHERE id=$1',[request_id])).rows[0];
   expect(request).toEqual({execution_status:boundary==='settled'?'succeeded':'outcome_unknown',settlement_status:boundary==='settled'?'settled':'unresolved',attempt_count:1});
   const costs=(await pool!.query('SELECT cost_units,charged_units FROM execution_attempts WHERE request_id=$1',[request_id])).rows;
   expect(costs).toEqual(boundary==='settled'?[{cost_units:capturedBefore,charged_units:capturedBefore}]:[{cost_units:null,charged_units:null}]);
   const reservation=(await pool!.query('SELECT captured_units,(max_units-captured_units-released_units)::text AS held FROM reservations WHERE operation_id=$1',[operation_id])).rows[0];
   expect(reservation.captured_units).toBe(capturedBefore);
   if(boundary==='settled'){expect(BigInt(capturedBefore)).toBeGreaterThan(0n);expect(reservation.held).toBe('0')}
   else{expect(capturedBefore).toBe('0');expect(BigInt(reservation.held)).toBeGreaterThan(0n)}
  }finally{
   if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child!.once('exit',resolve));child.kill('SIGKILL');await exited}
   if(http){http.closeAllConnections();await new Promise<void>((resolve,reject)=>http!.close(error=>error?reject(error):resolve()))}
   await transport.pause();await transport.queue('image').obliterate({force:true});await transport.close();await api.close();
   await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[fixture.scope.organization_id]);
   vi.unstubAllEnvs();
  }
 },90000);
});
