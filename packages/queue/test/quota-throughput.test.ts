import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {createPool,transaction} from '../../db/src/index.js';
import {id,systemClock,type Scope} from '../../contracts/src/index.js';
import {enqueue,leaseNext,type ExecutionRoute} from '../../execution/src/index.js';
import {recordAdmissionIntent,acquireDurable,type AdmissionInput} from '../src/admission.js';
import {recordAdmissionBundle,acquireAdmissionBundle} from '../src/admission-bundle.js';
import {QuotaStore} from '../src/quota.js';

// A timing benchmark: opt-in (pnpm test:quota-throughput), since a loaded machine distorts it.
const url=process.env.REDIS_URL,database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=process.env.UAI_TEST_THROUGHPUT==='1'&&!!process.env.DATABASE_URL&&!!url;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe.skipIf(!enabled)('admission throughput of one quota group',()=>{
 it('admits calls of one group side by side: twice the callers at model pace, nearly twice the admissions a second, no advisory waits',async()=>{
  vi.stubEnv('UAI_DB_POOL_MAX','40');
  const pool=createPool(database.url,'worker'),admin=database.pool!,installation=id('throughput');
  const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
  const report:Record<string,unknown>={};
  // Redis on another server, as on a two-server deployment: 10 ms on every acquire. Under a group-wide lock
  // this latency is paid one admission at a time; without it, side by side.
  const acquire=QuotaStore.acquireMany.bind(QuotaStore);
  const network=vi.spyOn(QuotaStore,'acquireMany').mockImplementation(async inputs=>{await delay(10);return acquire(inputs)});
  try{
   for(const mode of ['single','bundle'] as const){
    const group=id('quota'),domain=mode==='bundle'?id('domain'):null;
    await admin.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,concurrency_limit,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','test',100000,$3)",[group,scope.organization_id,domain]);
    await admin.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',100000000,60000)",[group]);
    const store=new QuotaStore(url!,installation,group,domain?JSON.stringify([scope.organization_id,domain]):undefined);await store.connect();
    // Calls of one group, each leased with its own fence and intent, as a worker holds them before admission.
    const prepareOne=async()=>{
     const request=await transaction(admin,tx=>enqueue(tx,scope,systemClock,{priority:10,operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'test',input_ref:'test',route,max_units:'0',deadline_at:new Date(Date.now()+600000)}));
     const lease=await transaction(admin,tx=>leaseNext(tx,systemClock,'worker',{scope,account:100000,application:100000,global:100000},undefined,request.id));
     const input:AdmissionInput={id:id('admission'),group_id:group,request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'requests',capacity:100000000,amount:1,window_ms:60000}]};
     const bundle=id('bundle');
     if(mode==='bundle')await recordAdmissionBundle(admin,bundle,[input]);else await recordAdmissionIntent(admin,input);
     return ()=>mode==='bundle'?acquireAdmissionBundle(pool,url!,installation,bundle):acquireDurable(pool,store,input);
    };
    // In batches: the setup must not wait on the admin pool's connections under a loaded machine.
    const prepare=async(count:number)=>{const calls=[];while(calls.length<count)calls.push(...await Promise.all(Array.from({length:Math.min(8,count-calls.length)},prepareOne)));return calls};
    // Each caller admits a call, the model answers in 150–250 ms, and it admits the next: five calls each, starts spread.
    const run=async(callers:number,turns=5)=>{
     const calls=await prepare(callers*turns);
     let sampling=true;const waiters:number[]=[],rowWaiters:number[]=[];
     const sample=(async()=>{while(sampling){const row=(await admin.query("SELECT count(*) FILTER (WHERE wait_event='advisory')::int AS advisory,count(*) FILTER (WHERE wait_event IN ('tuple','transactionid'))::int AS rows FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rows[0];waiters.push(row.advisory);rowWaiters.push(row.rows);await delay(5)}})();
     const took:number[]=[];const cpu=process.cpuUsage(),started=performance.now();
     const results=(await Promise.all(Array.from({length:callers},async(_,caller)=>{const own=[];await delay(Math.random()*200);for(let turn=0;turn<turns;turn++){const t=performance.now();own.push(await calls[caller*turns+turn]!());took.push(performance.now()-t);await delay(150+Math.random()*100)}return own}))).flat();
     const ms=performance.now()-started,used=process.cpuUsage(cpu);
     sampling=false;await sample;
     expect(results.every(result=>result.allowed)).toBe(true);
     return {callers,admissions:results.length,ms:Math.round(ms),per_second:Math.round(results.length/ms*1000),advisory_waiters_mean:Math.round(waiters.reduce((a,b)=>a+b,0)/Math.max(1,waiters.length)*10)/10,row_lock_waiters_mean:Math.round(rowWaiters.reduce((a,b)=>a+b,0)/Math.max(1,rowWaiters.length)*10)/10,node_cpu_share:Math.round((used.user+used.system)/1000/ms*100)/100,admission_median_ms:Math.round([...took].sort((a,b)=>a-b)[Math.floor(took.length/2)]!),admission_p90_ms:Math.round([...took].sort((a,b)=>a-b)[Math.floor(took.length*0.9)]!)};
    };
    // Opens every connection of both pools before anything is measured.
    await run(32,1);
    const small=await run(16),large=await run(32);
    report[mode]={small,large,ratio:Math.round(large.per_second/small.per_second*100)/100};
    await store.close();
   }
   await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/quota-throughput.json',JSON.stringify(report,null,2)+'\n');
   for(const mode of ['single','bundle'] as const){
    const entry=report[mode] as {ratio:number;small:{advisory_waiters_mean:number};large:{advisory_waiters_mean:number}};
    expect(entry.ratio,mode).toBeGreaterThan(1.6);
    expect((entry.large as unknown as {admission_median_ms:number}).admission_median_ms,mode).toBeLessThan(100);
    expect(entry.large.advisory_waiters_mean,mode).toBeLessThanOrEqual(Math.max(1,entry.small.advisory_waiters_mean*1.5));
   }
  }finally{
   await admin.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);
   network.mockRestore();await pool.end();vi.unstubAllEnvs();
  }
 },180000);
});
