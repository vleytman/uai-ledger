/** Synthetic quota benchmark. Run only against a dedicated, disposable Redis. */
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {Redis} from 'ioredis';
import {QuotaStore} from '../packages/queue/src/quota.js';
if(process.env.UAI_QUOTA_BENCHMARK!=='test-only'||!process.env.REDIS_URL)throw new Error('dedicated_redis_and_opt_in_required');
const count=Number(process.env.QUOTA_BENCHMARK_EVENTS??1000);
if(!Number.isSafeInteger(count)||count<10||count>10000)throw new Error('invalid_event_count');
const name=randomUUID(),redis=new Redis(process.env.REDIS_URL),stores=Array.from({length:16},(_,i)=>new QuotaStore(process.env.REDIS_URL!,name,`group-${i}`,name));
const samples:number[]=[],commandSamples:number[]=[];
for(const store of stores){
 const evaluate=store.redis.eval.bind(store.redis);
 store.redis.eval=(async(...args:Parameters<typeof evaluate>)=>{const start=performance.now();try{return await evaluate(...args)}finally{commandSamples.push(performance.now()-start)}}) as typeof store.redis.eval;
}
const rules=Array.from({length:32},(_,i)=>({key:`rule-${i.toString().padStart(2,'0')}`,capacity:count*(i+1),amount:i+1,window_ms:i%2?86400000:3600000}));
const inputs=(id:string,demands=rules)=>stores.map(store=>({store,epoch:'benchmark',admissionId:id,demands}));
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const ruleKey=(group:number,key:string)=>`uai-quota:{${digest(JSON.stringify([name,name]))}}:group:${digest(`group-${group}`)}:rule:${digest(key)}`;
const distribution=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {p50:sorted[Math.ceil(sorted.length*.5)-1],p95:sorted[Math.ceil(sorted.length*.95)-1],max:sorted.at(-1)}};
try{
 await Promise.all(stores.map(async store=>{await store.connect();await store.markRestored('benchmark')}));
 const before=await redis.info('commandstats');
 for(let i=0;i<count;i++){
  const start=performance.now();assert.equal((await QuotaStore.acquireMany(inputs(`admission-${i}`))).allowed,true);samples.push(performance.now()-start);
 }
 const after=await redis.info('commandstats');
 const replayStart=performance.now();assert.equal((await QuotaStore.acquireMany(inputs('admission-0'))).allowed,true);const replayMs=performance.now()-replayStart;
 const denialStart=performance.now();const denial=await QuotaStore.acquireMany(inputs('exhausted'));assert.equal(denial.allowed,false);if(!denial.allowed)assert.equal(denial.reason,'limited');const denialMs=performance.now()-denialStart;
 for(const store of stores){const snapshot=await store.snapshot('benchmark',rules);assert.equal(snapshot.ready,true);if(snapshot.ready)for(let i=0;i<rules.length;i++)assert.equal(snapshot.rules[i]!.used,String(count*(i+1)))}
 let coldMs:number|null=null,largeDenialMs:number|null=null,partialExpiryMs:number|null=null;
 let remainingCount=count;
 if(process.env.QUOTA_BENCHMARK_EDGES==='1'){
  const largeStart=performance.now();
  const large=await QuotaStore.acquireMany(inputs('full-window-demand',rules.map(rule=>({...rule,amount:rule.capacity}))));
  assert.equal(large.allowed,false);if(!large.allowed)assert.equal(large.reason,'limited');largeDenialMs=performance.now()-largeStart;
  for(let group=0;group<stores.length;group++)await redis.del(...rules.map(rule=>`${ruleKey(group,rule.key)}:aggregate`));
  const coldStart=performance.now();
  assert.equal((await QuotaStore.acquireMany(inputs('cold-read',rules.map(rule=>({...rule,amount:0}))))).allowed,true);coldMs=performance.now()-coldStart;
  const expireCount=Math.floor(count/2);
  for(let group=0;group<stores.length;group++)for(const rule of rules){
   const changed=await redis.eval(`local clock=redis.call('TIME');local at=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)-tonumber(ARGV[1])-1000;local events=redis.call('ZRANGE',KEYS[1],0,tonumber(ARGV[2])-1);for _,event in ipairs(events) do redis.call('ZADD',KEYS[1],at,event) end;return #events`,1,ruleKey(group,rule.key),rule.window_ms,expireCount);
   assert.equal(Number(changed),expireCount);
  }
  const partialStart=performance.now();assert.equal((await QuotaStore.acquireMany(inputs('after-partial-expiry'))).allowed,true);partialExpiryMs=performance.now()-partialStart;
  remainingCount=count-expireCount+1;
  for(const store of stores){const snapshot=await store.snapshot('benchmark',rules);assert.equal(snapshot.ready,true);if(snapshot.ready)for(let i=0;i<rules.length;i++)assert.equal(snapshot.rules[i]!.used,String(remainingCount*(i+1)))}
 }
 let expiryMs:number|null=null;
 if(process.env.QUOTA_BENCHMARK_EXPIRE==='1'){
  // Dedicated synthetic history only: move event timestamps behind their actual
  // window while retaining warm aggregates. No wall-clock or production keys change.
  for(let group=0;group<stores.length;group++)for(const rule of rules){
   const key=ruleKey(group,rule.key);
   const changed=await redis.eval(`local clock=redis.call('TIME');local at=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)-tonumber(ARGV[1])-1000;local events=redis.call('ZRANGE',KEYS[1],0,-1);for _,event in ipairs(events) do redis.call('ZADD',KEYS[1],at,event) end;return #events`,1,key,rule.window_ms);
   assert.equal(Number(changed),remainingCount);
  }
  const start=performance.now();assert.equal((await QuotaStore.acquireMany(inputs('after-expiry'))).allowed,true);expiryMs=performance.now()-start;
  for(const store of stores){const snapshot=await store.snapshot('benchmark',rules);assert.equal(snapshot.ready,true);if(snapshot.ready)for(let i=0;i<rules.length;i++)assert.equal(snapshot.rules[i]!.used,String(i+1))}
 }
 const stats=(info:string)=>{const line=info.split('\n').find(line=>line.startsWith('cmdstat_eval:'))??'';return {calls:Number(line.match(/calls=(\d+)/)?.[1]??0),usec:Number(line.match(/usec=(\d+)/)?.[1]??0)}};
 const a=stats(before),b=stats(after);
 const report={created_at:new Date().toISOString(),groups:16,rules_per_group:32,events_per_rule:count,windows_ms:[3600000,86400000],weighted_accounting_matches:true,replay_did_not_consume:true,exhaustion_rejected:true,replay_ms:replayMs,exhaustion_denial_ms:denialMs,mass_expiry_ms:expiryMs,cold_aggregate_ms:coldMs,full_window_denial_ms:largeDenialMs,partial_expiry_ms:partialExpiryMs,client_roundtrip_ms:distribution(samples),quota_redis_command_ms:distribution(commandSamples),last_100_roundtrip_ms:distribution(samples.slice(-100)),redis_eval:{calls:b.calls-a.calls,total_usec:b.usec-a.usec,mean_ms:(b.usec-a.usec)/(b.calls-a.calls)/1000},limitations:['Dedicated Redis, shared local CPU; record concurrent work separately','Measures 1000 events by default, not unbounded day-window history','Redis commandstats isolate Lua execution; client roundtrip includes serialization and network']};
 if(process.env.QUOTA_BENCHMARK_REPORT)await writeFile(process.env.QUOTA_BENCHMARK_REPORT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}finally{await Promise.all(stores.map(store=>store.close()));await redis.quit()}
