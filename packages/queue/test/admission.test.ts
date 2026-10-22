import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {ConnectionService} from '../../reconciliation/src/connections.js';
import {recordAdmissionBundle,acquireAdmissionBundle} from '../src/admission-bundle.js';
import {providerAdmission} from '../src/provider-admission.js';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {createPool,transaction} from '../../db/src/index.js';
import {id,systemClock,type Scope} from '../../contracts/src/index.js';
import {enqueue,configureBudget,leaseNext,prepareDispatch,recordRemoteJob,leaseObservation,cancelRequest,type ExecutionRoute} from '../../execution/src/index.js';
import {QuotaStore} from '../src/quota.js';
import {recordAdmissionIntent,acquireDurable} from '../src/admission.js';
const url=process.env.REDIS_URL,enabled=!!process.env.DATABASE_URL&&!!url;
const database=isolatedTestDatabase(process.env.DATABASE_URL);
let pool:ReturnType<typeof createPool>|null=null;
beforeAll(async()=>{if(enabled){await database.initialize();pool=database.pool}});
afterAll(async()=>{await database.close()});
async function fixture(capacity=1){
 const scope:Scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
 const group=id('quota'),store=new QuotaStore(url!,'test',group);
 await store.connect();
 await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','epoch','test')",[group,scope.organization_id]);
 await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',$2,60000)",[group,capacity]);
 const route:ExecutionRoute={primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'};
 const add=async()=>{
  const request=await transaction(pool!,tx=>enqueue(tx,scope,systemClock,{priority:10,operation_id:id('op'),component:'text',client_request_key:id('key'),input_hash:'test',input_ref:'test',route,max_units:'0',deadline_at:new Date(Date.now()+60000)}));
  const lease=await transaction(pool!,tx=>leaseNext(tx,systemClock,'worker',{scope,account:10,application:10},undefined,request.id));
  return {id:id('admission'),group_id:group,request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'requests',capacity,amount:1,window_ms:60000}]};
 };
 const cleanup=async()=>{await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);await store.close()};
 return {scope,group,store,add,cleanup};
}
describe.skipIf(!enabled)('durable quota admission',()=>{
 for(const coordinated of [false,true])for(const boundary of ['restore','acquire'])it(`rejects the disconnected PostgreSQL owner at ${boundary} (${coordinated?'bundle':'single'})`,async()=>{
  const f=await fixture(),domain=id('domain'),bundle=id('bundle');
  let unblock!:()=>void,reached=false,pending:Promise<{result?:unknown;error?:any}>|undefined,spy:{mockRestore():void}|undefined;
  const gate=new Promise<void>(resolve=>{unblock=resolve});
  const replacement=new QuotaStore(url!,'test',f.group,coordinated?JSON.stringify([f.scope.organization_id,domain]):undefined);
  try{
   await replacement.connect();
   if(coordinated)await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   const input=await f.add();
   if(coordinated)await recordAdmissionBundle(pool!,bundle,[input]);else await recordAdmissionIntent(pool!,input);
   if(boundary==='restore'){
    const original=QuotaStore.prototype.markRestored;
    spy=vi.spyOn(QuotaStore.prototype,'markRestored').mockImplementationOnce(async function(this:QuotaStore,epoch){reached=true;await gate;return original.call(this,epoch)});
   }else{
    const original=QuotaStore.acquireMany.bind(QuotaStore);
    spy=vi.spyOn(QuotaStore,'acquireMany').mockImplementationOnce(async inputs=>{reached=true;await gate;return original(inputs)});
   }
   pending=(coordinated?acquireAdmissionBundle(pool!,url!,'test',bundle):acquireDurable(pool!,f.store,input)).then(result=>({result}),error=>({error}));
   await vi.waitFor(()=>expect(reached).toBe(true),{timeout:5000});
   const owners=(await pool!.query(`SELECT a.pid,a.state,a.xact_start FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
    WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
     AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND l.classid::bigint=((hashtextextended($1,8192)>>32)&4294967295)
     AND l.objid::bigint=(hashtextextended($1,8192)&4294967295)`,[f.group])).rows;
   expect(owners).toHaveLength(1);expect(owners[0]).toMatchObject({state:'idle',xact_start:null});
   expect((await pool!.query('SELECT pg_terminate_backend($1) AS terminated',[owners[0].pid])).rows[0].terminated).toBe(true);
   await vi.waitFor(async()=>expect((await pool!.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1',[owners[0].pid])).rows).toEqual([]),{timeout:5000});
   // Another owner completes recovery and admission before the old Redis call returns.
   expect((await (coordinated?acquireAdmissionBundle(pool!,url!,'test',bundle):acquireDurable(pool!,replacement,input))).allowed).toBe(true);
   unblock();const stale=await pending;expect(stale.result).toBeUndefined();expect(stale.error).toBeInstanceOf(Error);
   expect((await pool!.query('SELECT state,unused_at IS NOT NULL AS unused FROM dispatch_admissions WHERE id=$1',[input.id])).rows).toEqual([{state:'admitted',unused:false}]);
   const next=await f.add(),nextBundle=id('bundle');
   if(coordinated)await recordAdmissionBundle(pool!,nextBundle,[next]);else await recordAdmissionIntent(pool!,next);
   expect(await (coordinated?acquireAdmissionBundle(pool!,url!,'test',nextBundle):acquireDurable(pool!,replacement,next))).toMatchObject({allowed:false,reason:'limited'});
   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[input.request_id])).rows).toEqual([]);
   expect((await pool!.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
  }finally{unblock();await pending;spy?.mockRestore();await replacement.close();await f.cleanup()}
 });

 for(const change of ['none','cancel','capacity','concurrency','cooldown'])it(`confirms all bundle groups atomically after Redis while rechecking ${change}`,async()=>{
  const f=await fixture(100),second=id('quota'),domain=id('domain'),bundle=id('bundle');
  let unblock!:()=>void,reached=false,pending:Promise<{result?:unknown;error?:any}>|undefined,spy:{mockRestore():void}|undefined;
  const gate=new Promise<void>(resolve=>{unblock=resolve});
  try{
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2,concurrency_limit=2 WHERE id=$1',[f.group,domain]);
   await pool!.query(`INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain,concurrency_limit)
    VALUES($1,$2,$1,'fake','{}','epoch','test',$3,2)`,[second,f.scope.organization_id,domain]);
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',100,60000)",[second]);
   const inputsFor=async()=>{const input=await f.add();return [input,{...input,id:id('admission'),group_id:second}]};
   if(change==='concurrency'){
    const occupied=await inputsFor(),prior=id('bundle');await recordAdmissionBundle(pool!,prior,occupied);
    expect((await acquireAdmissionBundle(pool!,url!,'test',prior)).allowed).toBe(true);
   }
   const inputs=await inputsFor();await recordAdmissionBundle(pool!,bundle,inputs);
   const acquire=QuotaStore.acquireMany.bind(QuotaStore);
   spy=vi.spyOn(QuotaStore,'acquireMany').mockImplementationOnce(async permits=>{reached=true;await gate;return acquire(permits)});
   pending=acquireAdmissionBundle(pool!,url!,'test',bundle).then(result=>({result}),error=>({error}));
   await vi.waitFor(()=>expect(reached).toBe(true),{timeout:5000});
   const locks=async(key:string,namespace:number)=>(await pool!.query(`SELECT a.pid,a.state,a.xact_start FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
    WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
     AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND l.classid::bigint=((hashtextextended($1,$2)>>32)&4294967295)
     AND l.objid::bigint=(hashtextextended($1,$2)&4294967295)`,[key,namespace])).rows;
   const held=await locks(bundle,8193);expect(held).toHaveLength(1);expect(held[0]).toMatchObject({state:'idle',xact_start:null});
   for(const input of inputs)expect(await locks(input.group_id,8192)).toEqual(held);
   await transaction(pool!,async tx=>{
    await tx.query("SET LOCAL lock_timeout='500ms'");
    await tx.query('SELECT id FROM execution_requests WHERE id=$1 FOR UPDATE',[inputs[0].request_id]);
    if(change==='cancel')await cancelRequest(tx,f.scope,systemClock,inputs[0].request_id);
    if(change==='capacity'){
     await tx.query('UPDATE provider_quota_groups SET revision=revision+1 WHERE id=$1',[second]);
     await tx.query('UPDATE provider_quota_rules SET capacity=101 WHERE group_id=$1',[second]);
    }
    if(change==='cooldown')await tx.query("UPDATE provider_quota_groups SET blocked_until=now()+interval '1 minute' WHERE id=$1",[second]);
    if(change==='concurrency')await tx.query('UPDATE provider_quota_groups SET concurrency_limit=1 WHERE id=$1',[second]);
   });
   unblock();const outcome=await pending;
   const rows=(await pool!.query('SELECT state,unused_at IS NOT NULL AS unused FROM dispatch_admissions WHERE id=ANY($1::text[])',[inputs.map(input=>input.id)])).rows;
   if(change==='none'){
    expect(outcome.result).toMatchObject({allowed:true});expect(rows).toEqual([{state:'admitted',unused:false},{state:'admitted',unused:false}]);
   }else{
    expect(outcome.error?.code).toBe(change==='cancel'?'stale_lease':change==='capacity'?'quota_rules_mismatch':change==='concurrency'?'quota_concurrency_changed':'quota_cooldown_changed');
    expect(rows).toEqual([{state:'intent',unused:true},{state:'intent',unused:true}]);
   }
   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[inputs[0].request_id])).rows).toEqual([]);
   expect(await locks(bundle,8193)).toEqual([]);for(const input of inputs)expect(await locks(input.group_id,8192)).toEqual([]);
  }finally{unblock();await pending;spy?.mockRestore();await f.cleanup()}
 });

 for(const change of ['none','cancel','capacity','concurrency','cooldown'])it(`keeps Redis outside SQL transactions and rechecks ${change} before confirming single admission`,async()=>{
  const f=await fixture(change==='concurrency'?100:1);let unblock!:()=>void,reached=false;
  const gate=new Promise<void>(resolve=>{unblock=resolve});
  let pending:Promise<{result?:unknown;error?:any}>|undefined,spy:{mockRestore():void}|undefined;
  try{
   if(change==='concurrency'){
    await pool!.query('UPDATE provider_quota_groups SET concurrency_limit=2 WHERE id=$1',[f.group]);
    const occupied=await f.add();await recordAdmissionIntent(pool!,occupied);expect((await acquireDurable(pool!,f.store,occupied)).allowed).toBe(true);
   }
   const input=await f.add();await recordAdmissionIntent(pool!,input);
   const acquire=f.store.acquire.bind(f.store);
   spy=vi.spyOn(f.store,'acquire').mockImplementationOnce(async(...args)=>{reached=true;await gate;return acquire(...args)});
   pending=acquireDurable(pool!,f.store,input).then(result=>({result}),error=>({error}));
   await vi.waitFor(()=>expect(reached).toBe(true),{timeout:5000});
   const locks=async()=>(await pool!.query(`SELECT a.state,a.xact_start FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
    WHERE l.locktype='advisory' AND l.granted AND l.objsubid=1
     AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
     AND l.classid::bigint=((hashtextextended($1,8192)>>32)&4294967295)
     AND l.objid::bigint=(hashtextextended($1,8192)&4294967295)`,[f.group])).rows;
   expect(await locks()).toEqual([{state:'idle',xact_start:null}]);
   await transaction(pool!,async tx=>{
    await tx.query("SET LOCAL lock_timeout='500ms'");
    await tx.query('SELECT id FROM execution_requests WHERE id=$1 FOR UPDATE',[input.request_id]);
    if(change==='cancel')await cancelRequest(tx,f.scope,systemClock,input.request_id);
    if(change==='capacity'){
     await tx.query('UPDATE provider_quota_groups SET revision=revision+1 WHERE id=$1',[f.group]);
     await tx.query('UPDATE provider_quota_rules SET capacity=2 WHERE group_id=$1',[f.group]);
    }
    if(change==='cooldown')await tx.query("UPDATE provider_quota_groups SET blocked_until=now()+interval '1 minute' WHERE id=$1",[f.group]);
    if(change==='concurrency')await tx.query('UPDATE provider_quota_groups SET concurrency_limit=1 WHERE id=$1',[f.group]);
   });
   unblock();const outcome=await pending;
   if(change==='none')expect(outcome.result).toMatchObject({allowed:true});
   else{
    expect(outcome.error?.code).toBe(change==='cancel'?'stale_lease':change==='capacity'?'quota_rules_mismatch':change==='concurrency'?'quota_concurrency_changed':'quota_cooldown_changed');
    expect((await pool!.query('SELECT state,unused_at IS NOT NULL AS unused FROM dispatch_admissions WHERE id=$1',[input.id])).rows).toEqual([{state:'intent',unused:true}]);
   }
   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[input.request_id])).rows).toEqual([]);
   // The pooled session must not retain its group lock after either success or rejection.
   expect(await locks()).toEqual([]);
   expect(await transaction(pool!,async tx=>(await tx.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,8192)) AS available',[f.group])).rows[0].available)).toBe(true);
  }finally{unblock();await pending;spy?.mockRestore();await f.cleanup()}
 });
 for(const coordinated of [false,true])it(`rechecks a full concurrency group before its remote safety hold expires (${coordinated?'bundle':'single'})`,async()=>{
  const f=await fixture(100);
  try{
   await pool!.query('UPDATE provider_quota_groups SET concurrency_limit=1,coordination_domain=$2 WHERE id=$1',[f.group,coordinated?id('domain'):null]);
   const first=await f.add(),waiting=await f.add(),firstBundle=id('bundle'),waitingBundle=id('bundle');
   const record=async(input:typeof first,bundle:string)=>coordinated?recordAdmissionBundle(pool!,bundle,[input]):recordAdmissionIntent(pool!,input);
   const acquire=async(input:typeof first,bundle:string)=>coordinated?acquireAdmissionBundle(pool!,url!,'test',bundle):acquireDurable(pool!,f.store,input);
   await record(first,firstBundle);expect((await acquire(first,firstBundle)).allowed).toBe(true);
   await record(waiting,waitingBundle);
   const refused=await acquire(waiting,waitingBundle);
   expect(refused).toMatchObject({allowed:false,reason:'limited',rule:'concurrency'});
   if(refused.allowed)throw new Error('concurrency exceeded');
   expect(refused.retry_at).toBeLessThanOrEqual(Date.now()+1100);
   // An early recheck does not release or bypass the still-held provider slot.
   expect((await acquire(waiting,waitingBundle)).allowed).toBe(false);
   await pool!.query('UPDATE dispatch_admissions SET slot_released_at=now() WHERE id=$1',[first.id]);
   expect((await acquire(waiting,waitingBundle)).allowed).toBe(true);
  }finally{await f.cleanup()}
 });
 for(const coordinated of [false,true])it(`does not age uncertain consumption from intent creation (${coordinated?'bundle':'single'})`,async()=>{
  const f=await fixture(),domain=id('domain');let spy:{mockRestore():void}|undefined;
  try{
   await pool!.query('UPDATE provider_quota_rules SET window_ms=1000 WHERE group_id=$1',[f.group]);
   if(coordinated)await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   const first=await f.add();first.demands[0].window_ms=1000;const bundle=id('bundle');
   if(coordinated)await recordAdmissionBundle(pool!,bundle,[first]);else await recordAdmissionIntent(pool!,first);
   // Intent waited two seconds, then Redis consumed quota now. The request lease is still live.
   await pool!.query("UPDATE dispatch_admissions SET created_at=now()-interval '2 seconds' WHERE id=$1",[first.id]);
   if(coordinated){
    const acquire=QuotaStore.acquireMany.bind(QuotaStore);
    spy=vi.spyOn(QuotaStore,'acquireMany').mockImplementationOnce(async inputs=>{await acquire(inputs);throw new Error('lost acknowledgement')});
   }else{
    const acquire=f.store.acquire.bind(f.store);
    spy=vi.spyOn(f.store,'acquire').mockImplementationOnce(async(...args)=>{await acquire(...args);throw new Error('lost acknowledgement')});
   }
   await expect(coordinated?acquireAdmissionBundle(pool!,url!,'test',bundle):acquireDurable(pool!,f.store,first)).rejects.toThrow('lost acknowledgement');
   spy.mockRestore();spy=undefined;
   const redisDomain=coordinated?JSON.stringify([f.scope.organization_id,domain]):f.group;
   const tag=createHash('sha256').update(JSON.stringify(['test',redisDomain])).digest('hex');
   const keys=await f.store.redis.keys(`uai-quota:{${tag}}:*`);expect(keys.length).toBeGreaterThan(0);await f.store.redis.del(...keys);
   const second=await f.add();second.demands[0].window_ms=1000;const secondBundle=id('bundle');
   if(coordinated)await recordAdmissionBundle(pool!,secondBundle,[second]);else await recordAdmissionIntent(pool!,second);
   expect(await (coordinated?acquireAdmissionBundle(pool!,url!,'test',secondBundle):acquireDurable(pool!,f.store,second))).toMatchObject({allowed:false,reason:'limited'});
  }finally{spy?.mockRestore();await f.cleanup()}
 });
 for(const reason of ['not_ready','conflict'] as const)it(`retains uncertain single-group intent after ${reason} and restores consumed quota`,async()=>{
  const f=await fixture();let spy:{mockRestore():void}|undefined;
  try{
   const first=await f.add();await recordAdmissionIntent(pool!,first);
   const acquire=f.store.acquire.bind(f.store);
   spy=vi.spyOn(f.store,'acquire').mockImplementationOnce(async(...args)=>{await acquire(...args);throw new Error('lost acknowledgement')});
   await expect(acquireDurable(pool!,f.store,first)).rejects.toThrow('lost acknowledgement');spy.mockRestore();
   spy=vi.spyOn(f.store,'acquire').mockResolvedValueOnce({allowed:false,reason});
   expect(await acquireDurable(pool!,f.store,first)).toEqual({allowed:false,reason});spy.mockRestore();spy=undefined;
   expect((await pool!.query('SELECT state,rejection FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0]).toEqual({state:'intent',rejection:null});
   // Lose only this fixture's Redis data. The uncertain consumption must survive in PostgreSQL.
   const tag=createHash('sha256').update(JSON.stringify(['test',f.group])).digest('hex');
   const keys=await f.store.redis.keys(`uai-quota:{${tag}}:*`);expect(keys.length).toBeGreaterThan(0);await f.store.redis.del(...keys);
   const second=await f.add();await recordAdmissionIntent(pool!,second);
   expect(await acquireDurable(pool!,f.store,second)).toMatchObject({allowed:false,reason:'limited'});
  }finally{spy?.mockRestore();await f.cleanup()}
 });
 it('records the entire group set atomically and refuses partial single-group admission',async()=>{
  const f=await fixture();const second=id('quota'),domain=id('domain'),bundleId=id('bundle');
  try{
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','test',$3)",[second,f.scope.organization_id,domain]);
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1,60000)",[second]);
   const first=await f.add(),other={...first,id:id('admission'),group_id:second};
   const result=await recordAdmissionBundle(pool!,bundleId,[first,other]);
   expect((await recordAdmissionBundle(pool!,bundleId,[other,first])).id).toBe(result.id);
   const rows=(await pool!.query('SELECT a.state,a.created_at FROM dispatch_admissions a JOIN dispatch_admission_bundle_members b ON b.admission_id=a.id WHERE b.bundle_id=$1',[bundleId])).rows;
   expect(rows).toHaveLength(2);expect(rows.every(row=>row.state==='intent')).toBe(true);
   expect(rows[0].created_at).toEqual(rows[1].created_at);
   await expect(recordAdmissionBundle(pool!,bundleId,[first,{...other,demands:[{...other.demands[0]!,amount:0}]}])).rejects.toMatchObject({code:'idempotency_conflict'});
   await expect(acquireDurable(pool!,f.store,first)).rejects.toMatchObject({code:'quota_bundle_required'});
   const next=await f.add(),nextOther={...next,id:id('admission'),group_id:second};
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[second,id('different-domain')]);
   const failed=id('bundle');
   await expect(recordAdmissionBundle(pool!,failed,[next,nextOther])).rejects.toMatchObject({code:'quota_domains_must_match'});
   expect((await pool!.query('SELECT id FROM dispatch_admission_bundles WHERE id=$1',[failed])).rows).toHaveLength(0);
   expect((await pool!.query('SELECT id FROM dispatch_admissions WHERE id=ANY($1::text[])',[[next.id,nextOther.id]])).rows).toHaveLength(0);
  }finally{await f.cleanup()}
 });
 it('acknowledges every group together and replays after losing the Redis acknowledgement',async()=>{
  const f=await fixture(2),second=id('quota'),domain=id('domain'),bundle=id('bundle');
  let spy:{mockRestore():void}|undefined;
  try{
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','test',$3)",[second,f.scope.organization_id,domain]);
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1,60000)",[second]);
   const first=await f.add(),other={...first,id:id('admission'),group_id:second,demands:[{...first.demands[0]!,capacity:1}]};
   await recordAdmissionBundle(pool!,bundle,[first,other]);
   const acquire=QuotaStore.acquireMany.bind(QuotaStore);
   spy=vi.spyOn(QuotaStore,'acquireMany').mockImplementationOnce(async inputs=>{await acquire(inputs);throw new Error('lost bundle acknowledgement')});
   await expect(acquireAdmissionBundle(pool!,url!,'test',bundle)).rejects.toThrow('lost bundle acknowledgement');
   spy.mockRestore();spy=undefined;
   const states=async()=>(await pool!.query('SELECT state,admitted_at,slot_heartbeat_until IS NOT NULL AS has_slot FROM dispatch_admissions WHERE id=ANY($1::text[])',[[first.id,other.id]])).rows;
   expect((await states()).map(row=>row.state)).toEqual(['intent','intent']);
   expect(await acquireAdmissionBundle(pool!,url!,'test',bundle)).toMatchObject({allowed:true,replayed:true});
   const admitted=await states();expect(admitted.every(row=>row.state==='admitted'&&row.has_slot)).toBe(true);expect(admitted[0].admitted_at).toEqual(admitted[1].admitted_at);
   const next=await f.add(),nextOther={...other,id:id('admission'),request_id:next.request_id,fence:next.fence};const nextBundle=id('bundle');
   await recordAdmissionBundle(pool!,nextBundle,[next,nextOther]);
   expect(await acquireAdmissionBundle(pool!,url!,'test',nextBundle)).toMatchObject({allowed:false,reason:'limited'});
   expect((await pool!.query('SELECT state FROM dispatch_admissions WHERE id=ANY($1::text[])',[[next.id,nextOther.id]])).rows.map(row=>row.state)).toEqual(['rejected','rejected']);
   const accountStore=new QuotaStore(url!,'test',f.group,JSON.stringify([f.scope.organization_id,domain]));
   try{
    await accountStore.connect();
    const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
    const prefix=`uai-quota:{${digest(JSON.stringify(['test',JSON.stringify([f.scope.organization_id,domain])]))}}:group:${digest(f.group)}`;
    const keys=await accountStore.redis.keys(`${prefix}:*`);expect(keys.length).toBeGreaterThan(0);await accountStore.redis.del(...keys);
    expect(await acquireAdmissionBundle(pool!,url!,'test',bundle)).toMatchObject({allowed:true,replayed:true});
    expect(await accountStore.acquire('epoch','remaining',first.demands)).toMatchObject({allowed:true});
   }finally{await accountStore.close()}
  }finally{spy?.mockRestore();await f.cleanup()}
 });
 it('rechecks every limit after partial Redis loss of an unacknowledged unsent bundle',async()=>{
  const f=await fixture(2),second=id('quota'),domain=id('domain'),bundle=id('bundle');
  let spy:{mockRestore():void}|undefined;
  const atomicDomain=JSON.stringify([f.scope.organization_id,domain]);
  const observer=new QuotaStore(url!,'test',f.group,atomicDomain);
  try{
   await observer.connect();
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','test',$3)",[second,f.scope.organization_id,domain]);
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1,60000)",[second]);
   const first=await f.add(),other={...first,id:id('admission'),group_id:second,demands:[{...first.demands[0]!,capacity:1}]};
   await recordAdmissionBundle(pool!,bundle,[first,other]);
   const acquire=QuotaStore.acquireMany.bind(QuotaStore);
   spy=vi.spyOn(QuotaStore,'acquireMany').mockImplementationOnce(async inputs=>{await acquire(inputs);throw new Error('lost ack')});
   await expect(acquireAdmissionBundle(pool!,url!,'test',bundle)).rejects.toThrow('lost ack');spy.mockRestore();spy=undefined;
   const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
   const prefix=`uai-quota:{${digest(JSON.stringify(['test',atomicDomain]))}}:group:${digest(f.group)}`;
   const keys=await observer.redis.keys(`${prefix}:*`);await observer.redis.del(...keys);
   expect(await acquireAdmissionBundle(pool!,url!,'test',bundle)).toMatchObject({allowed:true,replayed:false});
   expect(await acquireAdmissionBundle(pool!,url!,'test',bundle)).toMatchObject({allowed:true,replayed:true});
   expect(await observer.acquire('epoch','remaining-after-repair',first.demands)).toMatchObject({allowed:true});
   expect(await observer.acquire('epoch','no-more',first.demands)).toMatchObject({allowed:false,reason:'limited'});
   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[first.request_id])).rows).toHaveLength(0);
  }finally{spy?.mockRestore();await observer.close();await f.cleanup()}
 });
 it('shares consumption between a coordinated singleton and a two-group route',async()=>{
  const f=await fixture(1),second=id('quota'),domain=id('domain');
  try{
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','test',$3)",[second,f.scope.organization_id,domain]);
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1,60000)",[second]);
   const first=await f.add(),one=id('bundle');
   await recordAdmissionBundle(pool!,one,[first]);
   expect(await acquireAdmissionBundle(pool!,url!,'test',one)).toMatchObject({allowed:true});
   expect(await acquireAdmissionBundle(pool!,url!,'test',one)).toMatchObject({allowed:true,replayed:true});
   const next=await f.add(),pair=id('bundle'),other={...next,id:id('admission'),group_id:second};
   await recordAdmissionBundle(pool!,pair,[next,other]);
   expect(await acquireAdmissionBundle(pool!,url!,'test',pair)).toMatchObject({allowed:false,reason:'limited'});
   // Failure of the shared group must leave the independent group untouched.
   const third={...await f.add(),group_id:second},independent=id('bundle');
   await recordAdmissionBundle(pool!,independent,[third]);
   expect(await acquireAdmissionBundle(pool!,url!,'test',independent)).toMatchObject({allowed:true});
  }finally{await f.cleanup()}
 });
 it('requires every bound group to have a live permit before creating a submission intent',async()=>{
  const f=await fixture(),second=id('quota'),domain=id('domain'),bundle=id('bundle');
  try{
   await pool!.query('UPDATE provider_quota_groups SET coordination_domain=$2 WHERE id=$1',[f.group,domain]);
   await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,coordination_domain) VALUES($1,$2,$1,'fake','{}','epoch','test',$3)",[second,f.scope.organization_id,domain]);
   await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',1,60000)",[second]);
   const first=await f.add(),other={...first,id:id('admission'),group_id:second};
   await recordAdmissionBundle(pool!,bundle,[first,other]);await acquireAdmissionBundle(pool!,url!,'test',bundle);
   const connection=await transaction(pool!,tx=>new ConnectionService(tx,systemClock).create(f.scope,{provider:'fake',name:'Bundle proof',account_scope:{fixture:'test'},capabilities:{usage_reporting:false,cost_reporting:false,balance_reporting:false,request_cost_lookup:false,reporting_granularity:[],reporting_lag_seconds:null},limits:{},risk_policy:{}},{actor_id:'test',reason:'Quota proof test'}));
   await transaction(pool!,async tx=>{await configureBudget(tx,f.scope,'provider',connection.id,'0');await configureBudget(tx,f.scope,'period','test','0')});
   await pool!.query("UPDATE execution_requests SET execution_backend='bullmq',route=jsonb_set(route,'{primary,connection_id}',to_jsonb($2::text)) WHERE id=$1",[first.request_id,connection.id]);
   await pool!.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'fake',$2),($1,'fake',$3)",[connection.id,f.group,second]);
   const prepare=()=>transaction(pool!,tx=>prepareDispatch(tx,f.scope,systemClock,first.request_id,first.fence,undefined,first.id));
   await pool!.query("UPDATE dispatch_admissions SET slot_heartbeat_until=now()-interval '1 second' WHERE id=$1",[other.id]);
   await expect(prepare()).rejects.toMatchObject({code:'quota_admission_invalid'});
   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[first.request_id])).rows).toHaveLength(0);
   await pool!.query("UPDATE dispatch_admissions SET slot_heartbeat_until=now()+interval '30 seconds' WHERE id=$1",[other.id]);
   await pool!.query("DELETE FROM provider_quota_bindings WHERE connection_id=$1 AND group_id=$2",[connection.id,second]);
   await expect(prepare()).rejects.toMatchObject({code:'quota_admission_invalid'});
   await pool!.query("INSERT INTO provider_quota_bindings(connection_id,model,group_id) VALUES($1,'fake',$2)",[connection.id,second]);
   const attempt=await prepare();expect(attempt.quota_admission_id).toBe(first.id);
   const broker=providerAdmission(pool!,url!,'test');
   try{
    const request={id:first.request_id,fencing_token:first.fence};
    await broker.renewAdmission(request,attempt);
    await pool!.query("UPDATE dispatch_admissions SET slot_heartbeat_until=now()-interval '1 second' WHERE id=$1",[other.id]);
    const before=(await pool!.query('SELECT slot_heartbeat_until FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0];
    await expect(broker.renewAdmission(request,attempt)).rejects.toMatchObject({code:'quota_slot_lost'});
    expect((await pool!.query('SELECT slot_heartbeat_until FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0]).toEqual(before);
    const observation={status:200,sent_at:new Date().toISOString(),received_at:new Date().toISOString(),headers:{'x-ratelimit-remaining-requests':'0','x-ratelimit-reset-requests':'60s'}};
    await broker.onRateLimits(f.scope,request,attempt,observation);
    expect((await pool!.query('SELECT status FROM provider_http_observations WHERE attempt_id=$1',[attempt.id])).rows).toEqual([{status:200}]);
    expect((await pool!.query('SELECT id FROM quota_observations WHERE attempt_id=$1',[attempt.id])).rows).toHaveLength(0);
    await pool!.query(`UPDATE provider_quota_groups SET scope='{"response_headers":true}' WHERE id=$1`,[second]);
    const failedRedis=vi.spyOn(QuotaStore.prototype,'observe').mockRejectedValueOnce(new Error('Redis unavailable'));
    try{await expect(broker.onRateLimits(f.scope,request,attempt,observation)).rejects.toThrow('Redis unavailable')}finally{failedRedis.mockRestore()}
    expect((await pool!.query('SELECT group_id,applied_at FROM quota_observations WHERE attempt_id=$1',[attempt.id])).rows).toEqual([{group_id:second,applied_at:null}]);
    const restarted=providerAdmission(pool!,url!,'test');
    try{
     await restarted.replayObservations();
     expect((await pool!.query('SELECT applied_at IS NOT NULL AS applied FROM quota_observations WHERE attempt_id=$1',[attempt.id])).rows).toEqual([{applied:true}]);
     expect((await pool!.query('SELECT status FROM provider_http_observations WHERE attempt_id=$1',[attempt.id])).rows).toEqual([{status:200}]);
     const replaySpy=vi.spyOn(QuotaStore.prototype,'observe');
     try{await restarted.replayObservations();expect(replaySpy).not.toHaveBeenCalled()}finally{replaySpy.mockRestore()}
    }finally{await restarted.close()}

    const unknown={outcome:'unknown' as const,failure:{kind:'unknown' as const,code:'timeout',sent:true},usage:{state:'unknown' as const,reason:'timeout'}};
    await broker.onProviderResult(f.scope,request,attempt,unknown);
    const unknownHolds=(await pool!.query('SELECT id,slot_unknown_at,slot_expires_at FROM dispatch_admissions WHERE id=ANY($1::text[]) ORDER BY id',[[first.id,other.id]])).rows;
    expect(unknownHolds).toHaveLength(2);expect(unknownHolds.every(row=>row.slot_unknown_at!==null)).toBe(true);
    await broker.onProviderResult(f.scope,request,attempt,unknown);
    expect((await pool!.query('SELECT id,slot_unknown_at,slot_expires_at FROM dispatch_admissions WHERE id=ANY($1::text[]) ORDER BY id',[[first.id,other.id]])).rows).toEqual(unknownHolds);
    await transaction(pool!,tx=>recordRemoteJob(tx,f.scope,systemClock,first.request_id,first.fence,attempt.id,'bundle-remote'));
    await broker.onNativePending(request,attempt);
    const holds=(await pool!.query('SELECT slot_heartbeat_until,slot_expires_at>now() AS held FROM dispatch_admissions WHERE id=ANY($1::text[])',[[first.id,other.id]])).rows;
    expect(holds).toEqual([{slot_heartbeat_until:null,held:true},{slot_heartbeat_until:null,held:true}]);
    await broker.onProviderResult(f.scope,request,attempt,{outcome:'failure',failure:{kind:'canceled',code:'cancel_confirmed',sent:true},usage:{state:'unknown',reason:'test'}});
    expect((await pool!.query('SELECT id FROM dispatch_admissions WHERE id=ANY($1::text[]) AND slot_released_at IS NULL',[[first.id,other.id]])).rows).toHaveLength(0);
    await expect(broker.onNativePending(request,attempt)).rejects.toMatchObject({code:'quota_slot_lost'});
   }finally{await broker.close()}

   expect((await pool!.query('SELECT id FROM execution_attempts WHERE request_id=$1',[first.request_id])).rows).toHaveLength(1);
  }finally{await f.cleanup()}
 });
 it('recovers after Redis consumed but PostgreSQL acknowledgement failed without consuming twice',async()=>{
  const f=await fixture();
  try{
   const input=await f.add();await recordAdmissionIntent(pool!,input);
   const acquire=f.store.acquire.bind(f.store);let fail=true;
   f.store.acquire=async(...args)=>{const result=await acquire(...args);if(fail){fail=false;throw new Error('lost acknowledgement')}return result};
   await expect(acquireDurable(pool!,f.store,input)).rejects.toThrow('lost acknowledgement');
   expect((await pool!.query('SELECT state FROM dispatch_admissions WHERE id=$1',[input.id])).rows[0].state).toBe('intent');
   expect(await acquireDurable(pool!,f.store,input)).toMatchObject({allowed:true,replayed:true});
   const other=await f.add();await recordAdmissionIntent(pool!,other);expect(await acquireDurable(pool!,f.store,other)).toMatchObject({allowed:false,reason:'limited'});
  }finally{await f.cleanup()}
 });
 it('retains uncertain consumption when another request takes the slot before retry and Redis is lost',async()=>{
  const f=await fixture(2),broker=providerAdmission(pool!,url!,'test');
  try{
   await pool!.query('UPDATE provider_quota_groups SET concurrency_limit=1 WHERE id=$1',[f.group]);
   const first=await f.add();await recordAdmissionIntent(pool!,first);
   const acquire=f.store.acquire.bind(f.store);
   f.store.acquire=async(...args)=>{await acquire(...args);throw new Error('lost acknowledgement')};
   await expect(acquireDurable(pool!,f.store,first)).rejects.toThrow('lost acknowledgement');
   f.store.acquire=acquire;
   const second=await f.add();await recordAdmissionIntent(pool!,second);
   expect((await acquireDurable(pool!,f.store,second)).allowed).toBe(true);
   expect(await acquireDurable(pool!,f.store,first)).toMatchObject({allowed:false,rule:'concurrency'});
   expect((await pool!.query('SELECT state FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0].state).toBe('intent');
   await broker.onProviderResult(f.scope,{}, {quota_admission_id:second.id},{outcome:'failure',failure:{kind:'quota',code:'insufficient_quota',sent:true},usage:{state:'unknown',reason:'test'}});
   const prefix=`uai-quota:{${createHash('sha256').update(JSON.stringify(['test',f.group])).digest('hex')}}`;
   const keys=await f.store.redis.keys(`${prefix}:*`);if(keys.length)await f.store.redis.del(...keys);
   const third=await f.add();await recordAdmissionIntent(pool!,third);
   expect(await acquireDurable(pool!,f.store,third)).toMatchObject({allowed:false,reason:'limited',rule:'requests'});
   // The uncertain admission can still recover its original token without double consumption.
   expect(await acquireDurable(pool!,f.store,first)).toMatchObject({allowed:true,replayed:true});
  }finally{await broker.close();await f.cleanup()}
 });
 it('rebuilds lost Redis state from accepted PostgreSQL admissions before allowing new work',async()=>{
  const f=await fixture();try{
   const first=await f.add();await recordAdmissionIntent(pool!,first);expect((await acquireDurable(pool!,f.store,first)).allowed).toBe(true);
   const prefix=`uai-quota:{${createHash('sha256').update(JSON.stringify(['test',f.group])).digest('hex')}}`;
   const keys=await f.store.redis.keys(`${prefix}:*`);if(keys.length)await f.store.redis.del(...keys);
   const before=(await pool!.query('SELECT slot_expires_at FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0];
   expect(await acquireDurable(pool!,f.store,first)).toMatchObject({allowed:true,replayed:true});
   expect((await pool!.query('SELECT slot_expires_at FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0]).toEqual(before);
   const second=await f.add();await recordAdmissionIntent(pool!,second);expect(await acquireDurable(pool!,f.store,second)).toMatchObject({allowed:false,reason:'limited'});
  }finally{await f.cleanup()}
 });
 it('persists temporary cooldown but does not treat billing failures as retryable rate limits',async()=>{
  const f=await fixture(),broker=providerAdmission(pool!,url!,'test');
  try{
   const input=await f.add();await recordAdmissionIntent(pool!,input);await acquireDurable(pool!,f.store,input);
   const attempt={quota_admission_id:input.id};
   await broker.onProviderResult(f.scope,{},attempt,{outcome:'failure',failure:{kind:'quota',code:'insufficient_quota',sent:true},usage:{state:'unknown',reason:'test'}});
   expect((await pool!.query('SELECT blocked_until FROM provider_quota_groups WHERE id=$1',[f.group])).rows[0].blocked_until).toBeNull();
   const failure={outcome:'failure' as const,failure:{kind:'transient' as const,code:'rate_limit_exceeded',retry_after_ms:90000,sent:true},usage:{state:'unknown' as const,reason:'test'}};
   const outage=vi.spyOn(QuotaStore.prototype,'blockUntil').mockRejectedValueOnce(new Error('Redis offline'));
   try{await expect(broker.onProviderResult(f.scope,{},attempt,failure)).rejects.toThrow('Redis offline')}finally{outage.mockRestore()}
   expect((await pool!.query('SELECT cooldown_applied_until FROM provider_quota_groups WHERE id=$1',[f.group])).rows[0].cooldown_applied_until).toBeNull();

   const blocked=(await pool!.query('SELECT blocked_until FROM provider_quota_groups WHERE id=$1',[f.group])).rows[0].blocked_until;
   expect(new Date(blocked).getTime()).toBeGreaterThan(Date.now()+85000);
   const recovered=providerAdmission(pool!,url!,'test');
   try{await recovered.replayCooldowns()}finally{await recovered.close()}
   expect((await pool!.query('SELECT cooldown_applied_until FROM provider_quota_groups WHERE id=$1',[f.group])).rows[0].cooldown_applied_until).toEqual(blocked);
   await broker.onProviderResult(f.scope,{},attempt,failure);
   expect((await pool!.query('SELECT blocked_until FROM provider_quota_groups WHERE id=$1',[f.group])).rows[0].blocked_until).toEqual(blocked);

   await f.store.closeGate();const second=await f.add();await recordAdmissionIntent(pool!,second);
   const result=await acquireDurable(pool!,f.store,second);expect(result).toMatchObject({allowed:false,reason:'limited'});
   if(!result.allowed)expect(result.retry_at).toBeGreaterThan(Date.now()+85000);
  }finally{await broker.close();await f.cleanup()}
 });
 it('arbitrates the last concurrent slot and releases only that slot after a known result',async()=>{
  const f=await fixture(100),broker=providerAdmission(pool!,url!,'test');
  try{
   await pool!.query('UPDATE provider_quota_groups SET concurrency_limit=1 WHERE id=$1',[f.group]);
   const inputs=await Promise.all([f.add(),f.add()]);
   await Promise.all(inputs.map(input=>recordAdmissionIntent(pool!,input)));
   const results=await Promise.all(inputs.map(input=>acquireDurable(pool!,f.store,input)));
   expect(results.filter(result=>result.allowed)).toHaveLength(1);
   expect(results.find(result=>!result.allowed)).toMatchObject({reason:'limited',rule:'concurrency'});
   const admitted=inputs[results.findIndex(result=>result.allowed)];
   await broker.onProviderResult(f.scope,{}, {quota_admission_id:admitted.id},{outcome:'failure',failure:{kind:'quota',code:'insufficient_quota',sent:true},usage:{state:'unknown',reason:'test'}});
   await expect(acquireDurable(pool!,f.store,admitted)).rejects.toMatchObject({code:'quota_slot_lost'});
   const next=await f.add();await recordAdmissionIntent(pool!,next);
   expect((await acquireDurable(pool!,f.store,next)).allowed).toBe(true);
  }finally{await broker.close();await f.cleanup()}
 });
 it('retains a bounded remote hold after worker heartbeat expires, without reviving the lease',async()=>{
  const f=await fixture(100),broker=providerAdmission(pool!,url!,'test');
  try{
   await pool!.query('UPDATE provider_quota_groups SET concurrency_limit=1 WHERE id=$1',[f.group]);
   const first=await f.add();await recordAdmissionIntent(pool!,first);await acquireDurable(pool!,f.store,first);
   await broker.renewAdmission({}, {quota_admission_id:first.id});
   const row=(await pool!.query('SELECT * FROM dispatch_admissions WHERE id=$1',[first.id])).rows[0];
   expect(new Date(row.slot_expires_at).getTime()-new Date(row.slot_heartbeat_until).getTime()).toBe(300000);
   await pool!.query("UPDATE dispatch_admissions SET slot_heartbeat_until=now()-interval '1 second' WHERE id=$1",[first.id]);
   await expect(broker.renewAdmission({}, {quota_admission_id:first.id})).rejects.toMatchObject({code:'quota_slot_lost'});
   const waiting=await f.add();await recordAdmissionIntent(pool!,waiting);
   expect(await acquireDurable(pool!,f.store,waiting)).toMatchObject({allowed:false,rule:'concurrency'});
   await pool!.query("UPDATE dispatch_admissions SET slot_expires_at=now()-interval '1 second' WHERE id=$1",[first.id]);
   const next=await f.add();await recordAdmissionIntent(pool!,next);expect((await acquireDurable(pool!,f.store,next)).allowed).toBe(true);
  }finally{await broker.close();await f.cleanup()}
 });
 it('does not extend unknown-result holds on duplicate feedback or heartbeat',async()=>{
  const f=await fixture(100),broker=providerAdmission(pool!,url!,'test');
  try{
   const input=await f.add();await recordAdmissionIntent(pool!,input);await acquireDurable(pool!,f.store,input);
   const attempt={quota_admission_id:input.id};
   const result={outcome:'unknown' as const,failure:{kind:'unknown' as const,code:'timeout',sent:true},usage:{state:'unknown' as const,reason:'timeout'}};
   await broker.onProviderResult(f.scope,{},attempt,result);
   const first=(await pool!.query('SELECT slot_expires_at FROM dispatch_admissions WHERE id=$1',[input.id])).rows[0];
   await broker.onProviderResult(f.scope,{},attempt,result);
   expect((await pool!.query('SELECT slot_expires_at FROM dispatch_admissions WHERE id=$1',[input.id])).rows[0]).toEqual(first);
   await expect(broker.renewAdmission({},attempt)).rejects.toMatchObject({code:'quota_slot_lost'});
  }finally{await broker.close();await f.cleanup()}
 });
 it('holds an observed native job across observer fences and releases it only on a terminal result',async()=>{
  const f=await fixture(100),broker=providerAdmission(pool!,url!,'test');
  try{
   const input=await f.add();await recordAdmissionIntent(pool!,input);await acquireDurable(pool!,f.store,input);
   await transaction(pool!,async tx=>{await configureBudget(tx,f.scope,'provider','fake','0');await configureBudget(tx,f.scope,'period','test','0')});
   const attempt=await transaction(pool!,tx=>prepareDispatch(tx,f.scope,systemClock,input.request_id,input.fence));
   await pool!.query('UPDATE execution_attempts SET quota_admission_id=$2 WHERE id=$1',[attempt.id,input.id]);attempt.quota_admission_id=input.id;
   await transaction(pool!,tx=>recordRemoteJob(tx,f.scope,systemClock,input.request_id,input.fence,attempt.id,'remote-test'));
   const submission={id:input.request_id,fencing_token:input.fence};
   await broker.onNativePending(submission,attempt);
   await pool!.query('UPDATE execution_requests SET lease_expires_at=NULL WHERE id=$1',[input.request_id]);
   const observer=await transaction(pool!,tx=>leaseObservation(tx,f.scope,systemClock,input.request_id,'observer'));
   await expect(broker.onNativePending(submission,attempt)).rejects.toMatchObject({code:'quota_slot_lost'});
   // A fresh provider observation may re-establish an expired hold, but not a released terminal slot.
   await pool!.query("UPDATE dispatch_admissions SET slot_expires_at=now()-interval '1 second' WHERE id=$1",[input.id]);
   await broker.onNativePending(observer,attempt);
   expect((await pool!.query('SELECT slot_expires_at>now() AS held,slot_heartbeat_until FROM dispatch_admissions WHERE id=$1',[input.id])).rows[0]).toEqual({held:true,slot_heartbeat_until:null});
   await broker.onProviderResult(f.scope,observer,attempt,{outcome:'failure',failure:{kind:'canceled',code:'cancel_confirmed',sent:true},usage:{state:'unknown',reason:'test'}});
   await expect(broker.onNativePending(observer,attempt)).rejects.toMatchObject({code:'quota_slot_lost'});
  }finally{await broker.close();await f.cleanup()}
 });
 it('rejects forged rules, stale fences and changed configuration',async()=>{
  const f=await fixture();try{
   const input=await f.add();await expect(recordAdmissionIntent(pool!,{...input,demands:[{...input.demands[0],capacity:100}]})).rejects.toMatchObject({code:'quota_rules_mismatch'});
   await expect(recordAdmissionIntent(pool!,{...input,fence:'999'})).rejects.toMatchObject({code:'stale_lease'});
   await recordAdmissionIntent(pool!,input);await pool!.query('UPDATE provider_quota_groups SET revision=revision+1 WHERE id=$1',[f.group]);
   await expect(acquireDurable(pool!,f.store,input)).rejects.toMatchObject({code:'quota_revision_changed'});
  }finally{await f.cleanup()}
 });
});
