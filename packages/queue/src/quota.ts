import {quotaPreparationScript} from './quota-preparation.js';
import {redisGenerationScript} from './redis-generation.js';
import {createHash} from 'node:crypto';
import {Redis} from 'ioredis';
import {redisConnection,redisClientPrefix} from './transport.js';
import {quotaSnapshotScript,type QuotaSnapshot} from './quota-snapshot.js';

export interface QuotaDemand {key:string;capacity:number;amount:number;window_ms:number}
export interface QuotaDenialDetails {group_id:string;rule:string;demand:string;available:string|null;capacity:string;window_ms:number|null;checked_at:number}
export type Admission={allowed:true;at:number;replayed:boolean}|{allowed:false;reason:'not_ready'|'conflict'|'too_large'|'limited';rule?:string;retry_at?:number;details?:QuotaDenialDetails};
/** Observation only: never accepted as an admission proof. null means insufficient state. */
export type QuotaPreview={would_allow:true}|{would_allow:false;reason:'too_large'|'limited';rule?:string;retry_at?:number}|{would_allow:null;reason:'not_ready'|'conflict'|'too_many_events'};
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const excessScript=`${redisGenerationScript}
local restore=ARGV[7]=='restore'
if restore and quota_run_id~=ARGV[8] then return 0 end
if not restore and redis.call('GET',KEYS[1])~=(ARGV[1]..':'..quota_run_id) then return 0 end
if not restore and redis.call('GET',KEYS[2])==ARGV[1] then return 1 end
local clock=redis.call('TIME');local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local amount=tonumber(ARGV[4]);local at=tonumber(ARGV[5]);local window=tonumber(ARGV[6])
if at>now-window then
 redis.call('ZADD',KEYS[3],at,ARGV[2]..'|'..ARGV[4]);redis.call('PEXPIRE',KEYS[3],window+60000)
 redis.call('DEL',KEYS[5])
 if not restore then
  local snapshot=redis.call('HGET',KEYS[4],ARGV[3])
  if snapshot then local observation=cjson.decode(snapshot)
   if observation.reset_at>now then observation.remaining=math.max(0,observation.remaining-amount);redis.call('HSET',KEYS[4],ARGV[3],cjson.encode(observation)) end
  end
 end
end
redis.call('SET',KEYS[2],ARGV[1],'PX',90000000)
return 1
`;
// Each slot is one provider-account domain; every key shares a Redis Cluster hash tag.
const restoreScript=`${redisGenerationScript}
if quota_run_id~=ARGV[5] then return 0 end
local at=tonumber(ARGV[1]);local identity=ARGV[2];local fingerprint=ARGV[3];local rules=cjson.decode(ARGV[4])
local cached=redis.call('GET',KEYS[1])
if cached then
 local prior=cjson.decode(cached)
 if prior.fingerprint~=fingerprint then return 0 end
 at=math.max(at,prior.at)
end
-- An owner that lost its SQL lock may finish a delayed Redis command.
-- Never move consumption back to an earlier window or overwrite a newer permit timestamp.
for i,rule in ipairs(rules) do
 if rule.amount>0 then
  local score=redis.call('ZSCORE',KEYS[i+1],identity..'|'..rule.amount)
  if score then at=math.max(at,tonumber(score)) end
 end
end
for i,rule in ipairs(rules) do
 if rule.amount>0 then
  redis.call('ZADD',KEYS[i+1],at,identity..'|'..rule.amount)
  redis.call('PEXPIRE',KEYS[i+1],rule.window_ms+60000)
  redis.call('DEL',KEYS[#rules+i+1])
 end
end
redis.call('SET',KEYS[1],cjson.encode({fingerprint=fingerprint,at=at}),'PX',86460000)
return 1
`;
const acquireScript=`${redisGenerationScript}
${quotaPreparationScript}
local preview=ARGV[2]=='preview';local previewLeft=10000
local groups=cjson.decode(ARGV[1])
local clock=redis.call('TIME');local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local cachedCount=0;local replayAt=nil
for _,group in ipairs(groups) do
 if redis.call('GET',KEYS[group.ready])~=(group.epoch..':'..quota_run_id) then return cjson.encode({allowed=false,reason='not_ready'}) end
 local cached=nil
 if not preview then cached=redis.call('GET',KEYS[group.admission]) end
 if cached then
  local prior=cjson.decode(cached)
  if prior.fingerprint~=group.fingerprint or (replayAt and replayAt~=prior.at) then return cjson.encode({allowed=false,reason='conflict'}) end
  cachedCount=cachedCount+1;replayAt=prior.at
 end
end
if cachedCount==#groups then return cjson.encode({allowed=true,at=replayAt,replayed=true}) end
if cachedCount>0 then return cjson.encode({allowed=false,reason='conflict'}) end
local blockedRule=nil;local blockedDetails=nil;local retry=now
for _,group in ipairs(groups) do
 for i,rule in ipairs(group.rules) do
  local key=KEYS[group.rule_keys[i]]
  if rule.amount>rule.capacity then return cjson.encode({allowed=false,reason='too_large',rule=rule.key,details={group_id=group.group_id,rule=rule.key,demand=string.format('%.0f',rule.amount),capacity=string.format('%.0f',rule.capacity),available=cjson.null,window_ms=rule.window_ms,checked_at=now}}) end
  local used=0;local availableAt=now
  if preview then
   -- Bound the entire read-only preview, not each of its 512 possible rules.
   local events=redis.call('ZRANGEBYSCORE',key,'('..(now-rule.window_ms),'+inf','WITHSCORES','LIMIT',0,previewLeft+1)
   if #events/2>previewLeft then return cjson.encode({allowed=false,reason='too_many_events'}) end
   previewLeft=previewLeft-#events/2
   for j=1,#events,2 do used=used+tonumber(string.match(events[j],'|(%d+)$')) end
   local remaining=used
   if remaining+rule.amount>rule.capacity then
    for j=1,#events,2 do
     remaining=remaining-tonumber(string.match(events[j],'|(%d+)$'))
     availableAt=tonumber(events[j+1])+rule.window_ms
     if remaining+rule.amount<=rule.capacity then break end
    end
   end
  else
   local prepared=prepareRule(key,KEYS[group.aggregate_keys[i]],rule,now)
   if not prepared then return cjson.encode({allowed=false,reason='preparing'}) end
   used=prepared.used;availableAt=prepared.available_at
  end
  local available=math.max(0,rule.capacity-used)
  local cooldown=tonumber(redis.call('HGET',KEYS[group.blocked],rule.key) or '0')
  availableAt=math.max(availableAt,cooldown)
  if cooldown>now then available=0 end
  local snapshot=redis.call('HGET',KEYS[group.observed],rule.key)
  if snapshot then local observation=cjson.decode(snapshot)
   if observation.reset_at>now then
    available=math.min(available,observation.remaining)
    if observation.remaining<rule.amount then availableAt=math.max(availableAt,observation.reset_at) end
   end
  end
  if availableAt>retry then
   retry=availableAt;blockedRule=rule.key
   blockedDetails={group_id=group.group_id,rule=rule.key,demand=string.format('%.0f',rule.amount),capacity=string.format('%.0f',rule.capacity),available=string.format('%.0f',available),window_ms=rule.window_ms,checked_at=now}
  end
 end
end
if blockedRule then return cjson.encode({allowed=false,reason='limited',rule=blockedRule,retry_at=retry,details=blockedDetails}) end
if preview then return cjson.encode({allowed=true}) end
for _,group in ipairs(groups) do
 local maxWindow=0
 for i,rule in ipairs(group.rules) do
  maxWindow=math.max(maxWindow,rule.window_ms)
  local snapshot=redis.call('HGET',KEYS[group.observed],rule.key)
  if snapshot then local observation=cjson.decode(snapshot)
   if observation.reset_at>now then observation.remaining=math.max(0,observation.remaining-rule.amount);redis.call('HSET',KEYS[group.observed],rule.key,cjson.encode(observation)) end
  end
  if rule.amount>0 then
   local added=redis.call('ZADD',KEYS[group.rule_keys[i]],now,group.identity..'|'..rule.amount)
   if added==1 then
    redis.call('HINCRBY',KEYS[group.aggregate_keys[i]],'used',rule.amount)
    redis.call('HINCRBY',KEYS[group.aggregate_keys[i]],'count',1)
    redis.call('HINCRBY',KEYS[group.aggregate_keys[i]],'revision',1)
    redis.call('PEXPIRE',KEYS[group.aggregate_keys[i]],rule.window_ms+60000)
   end
   redis.call('PEXPIRE',KEYS[group.rule_keys[i]],rule.window_ms+60000)
  end
 end
 redis.call('SET',KEYS[group.admission],cjson.encode({fingerprint=group.fingerprint,at=now}),'PX',math.max(maxWindow,86400000)+60000)
end
return cjson.encode({allowed=true,at=now,replayed=false})
`;
const discardUnsentScript=`${redisGenerationScript}
local groups=cjson.decode(ARGV[1])
for _,group in ipairs(groups) do
 if redis.call('GET',KEYS[group.ready])~=(group.epoch..':'..quota_run_id) then return 0 end
 local cached=redis.call('GET',KEYS[group.admission])
 if cached and cjson.decode(cached).fingerprint~=group.fingerprint then return 0 end
end
for _,group in ipairs(groups) do
 redis.call('DEL',KEYS[group.admission])
 for i,rule in ipairs(group.rules) do
  redis.call('ZREM',KEYS[group.rule_keys[i]],group.identity..'|'..rule.amount)
  redis.call('DEL',KEYS[group.aggregate_keys[i]])
 end
end
return 1
`;
const blockScript=`${redisGenerationScript}
if redis.call('GET',KEYS[1])~=(ARGV[1]..':'..quota_run_id) then return 0 end
local clock=redis.call('TIME');local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local old=tonumber(redis.call('HGET',KEYS[2],ARGV[2]) or '0')
redis.call('HSET',KEYS[2],ARGV[2],math.max(old,ARGV[4]=='absolute' and tonumber(ARGV[3]) or now+tonumber(ARGV[3])))
return 1
`;
const observationScript=`
local clock=redis.call('TIME');local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local reset=tonumber(ARGV[4]);if reset<=now then return 0 end
local remaining=tonumber(ARGV[2]);local sent=tonumber(ARGV[3])
local events=redis.call('ZRANGEBYSCORE',KEYS[1],sent,'+inf')
for _,event in ipairs(events) do remaining=remaining-tonumber(string.match(event,'|(%d+)$')) end
remaining=math.max(0,remaining)
local observedAt=tonumber(ARGV[5]);local previous=redis.call('HGET',KEYS[2],ARGV[1])
if previous then local old=cjson.decode(previous)
 if old.reset_at>now then remaining=math.min(remaining,old.remaining);reset=math.max(reset,old.reset_at);observedAt=math.max(observedAt,old.observed_at or 0) end
end
redis.call('HSET',KEYS[2],ARGV[1],cjson.encode({remaining=remaining,reset_at=reset,observed_at=observedAt}))
return 1
`;
export class QuotaStore {
 readonly redis:Redis;
 private readonly prefix:string;
 private recoveryRunId:string|undefined;
 private readonly coordination:string;
 constructor(url:string,installation:string,private readonly domain:string,atomicDomain?:string){
  if(!installation||!domain)throw new Error('quota_scope_required');
  this.coordination=digest(JSON.stringify([url,installation,atomicDomain??domain]));
  const tag=digest(JSON.stringify([installation,atomicDomain??domain]));
  this.prefix=`uai-quota:{${tag}}${atomicDomain?`:group:${digest(domain)}`:''}`;
  const commandTimeout=Number(process.env.UAI_REDIS_COMMAND_TIMEOUT_MS??2000);
  if(!Number.isSafeInteger(commandTimeout)||commandTimeout<50||commandTimeout>30000)throw new Error('invalid_redis_command_timeout');
  this.redis=new Redis({...redisConnection(url),connectionName:`${redisClientPrefix(installation)}quota:${process.pid}`,maxRetriesPerRequest:1,enableOfflineQueue:false,commandTimeout});
 }
 async connect(){if(this.redis.status!=='ready')await new Promise<void>((resolve,reject)=>{const done=()=>{this.redis.off('error',fail);resolve()};const fail=(error:Error)=>{this.redis.off('ready',done);reject(error)};this.redis.once('ready',done);this.redis.once('error',fail)});if(!this.recoveryRunId)this.recoveryRunId=String(await this.redis.eval(`${redisGenerationScript}return quota_run_id`,0));}
 /** Only the durable reconciler may open this gate AFTER restoring recent admissions/holds. */
 async markRestored(epoch:string){if(!epoch)throw new Error('quota_epoch_required');const opened=await this.redis.eval(`${redisGenerationScript}if quota_run_id~=ARGV[2] then return 0 end;redis.call('SET',KEYS[1],ARGV[1]..':'..quota_run_id);return 1`,1,`${this.prefix}:ready`,epoch,this.recoveryRunId??'');if(Number(opened)!==1)throw new Error('quota_redis_generation_changed')}
 async closeGate(){await this.redis.del(`${this.prefix}:ready`)}
 async acquire(epoch:string,admissionId:string,demands:QuotaDemand[]):Promise<Admission>{
  return QuotaStore.acquireMany([{store:this,epoch,admissionId,demands}]);
 }
 /** All groups must explicitly share a provider-account coordination domain. */
 static async acquireMany(inputs:Array<{store:QuotaStore;epoch:string;admissionId:string;demands:QuotaDemand[]}>):Promise<Admission>{
  const {first,keys,groups}=QuotaStore.prepareMany(inputs);
  // A preparation pass only maintains derived totals, never consumes permits.
  // Every final pass rechecks all rules, epochs, observations and cached permits.
  const deadline=performance.now()+20000;
  do {
   const result=JSON.parse(String(await first.redis.eval(acquireScript,keys.length,...keys,JSON.stringify(groups)))) as Admission|{allowed:false;reason:'preparing'};
   if(!result.allowed&&result.reason==='preparing')continue;
   return result;
  }while(performance.now()<deadline);
  return {allowed:false,reason:'not_ready'};
 }
 /** Same weighted-window/headers/cooldown calculation, enforced read-only by Redis. */
 static async previewMany(inputs:Array<{store:QuotaStore;epoch:string;demands:QuotaDemand[]}>):Promise<QuotaPreview>{
  const {first,keys,groups}=QuotaStore.prepareMany(inputs.map(input=>({...input,admissionId:'shadow-no-permit'})));
  const result=JSON.parse(String(await first.redis.call('EVAL_RO',acquireScript,keys.length,...keys,JSON.stringify(groups),'preview')));
  if(result.allowed)return {would_allow:true};
  if(result.reason==='limited'||result.reason==='too_large')return {would_allow:false,reason:result.reason,...(result.rule?{rule:result.rule}:{}),...(result.retry_at?{retry_at:result.retry_at}:{})};
  return {would_allow:null,reason:result.reason};
 }
 async preview(epoch:string,demands:QuotaDemand[]):Promise<QuotaPreview>{return QuotaStore.previewMany([{store:this,epoch,demands}])}
 /** Caller must hold every group lock and prove no submission exists for this fence. Provider observations are never refunded. */
 static async discardUnsentMany(inputs:Array<{store:QuotaStore;epoch:string;admissionId:string;demands:QuotaDemand[]}>):Promise<boolean>{
  const {first,keys,groups}=QuotaStore.prepareMany(inputs);
  return Number(await first.redis.eval(discardUnsentScript,keys.length,...keys,JSON.stringify(groups)))===1;
 }
 private static prepareMany(inputs:Array<{store:QuotaStore;epoch:string;admissionId:string;demands:QuotaDemand[]}>){
  if(!inputs.length||inputs.length>16)throw new Error('invalid_quota_groups');
  const first=inputs[0]!.store;
  if(inputs.some(input=>input.store.coordination!==first.coordination))throw new Error('quota_domains_must_match');
  if(new Set(inputs.map(input=>input.store.prefix)).size!==inputs.length)throw new Error('duplicate_quota_group');
  const keys:string[]=[];
  const add=(key:string)=>{keys.push(key);return keys.length};
  const groups=inputs.map(({store,epoch,admissionId,demands})=>{
   if(!epoch||!admissionId||!demands.length||demands.length>32)throw new Error('invalid_quota_admission');
   const rules=demands.map(({key,capacity,amount,window_ms})=>({key,capacity,amount,window_ms})).sort((a,b)=>a.key.localeCompare(b.key));
   if(new Set(rules.map(r=>r.key)).size!==rules.length)throw new Error('duplicate_quota_rule');
   for(const rule of rules)if(!rule.key||![rule.capacity,rule.amount,rule.window_ms].every(Number.isSafeInteger)||rule.capacity<1||rule.amount<0||rule.window_ms<1||rule.window_ms>86400000)throw new Error('invalid_quota_rule');
   const identity=digest(admissionId),prefix=store.prefix;
   return {group_id:store.domain,epoch,identity,fingerprint:digest(JSON.stringify(rules)),rules,
    ready:add(`${prefix}:ready`),admission:add(`${prefix}:admission:${identity}`),
    rule_keys:rules.map(rule=>add(`${prefix}:rule:${digest(rule.key)}`)),aggregate_keys:rules.map(rule=>add(`${prefix}:rule:${digest(rule.key)}:aggregate`)),blocked:add(`${prefix}:blocked`),observed:add(`${prefix}:observed`)};
  });
  return {first,keys,groups};
 }
 async block(epoch:string,rule:string,delayMs:number){if(!rule||!Number.isSafeInteger(delayMs)||delayMs<0||delayMs>86400000)throw new Error('invalid_quota_block');return Number(await this.redis.eval(blockScript,2,`${this.prefix}:ready`,`${this.prefix}:blocked`,epoch,rule,delayMs))===1}
 async blockUntil(epoch:string,rule:string,until:number){if(!rule||!Number.isSafeInteger(until)||until<0)throw new Error('invalid_quota_block');return Number(await this.redis.eval(blockScript,2,`${this.prefix}:ready`,`${this.prefix}:blocked`,epoch,rule,until,'absolute'))===1}
 async observe(rule:string,remaining:number,sentAt:number,resetAt:number,receivedAt=sentAt){
  if(!rule||![remaining,sentAt,resetAt,receivedAt].every(Number.isSafeInteger)||remaining<0||receivedAt<sentAt)throw new Error('invalid_quota_observation');
  await this.redis.eval(observationScript,2,`${this.prefix}:rule:${digest(rule)}`,`${this.prefix}:observed`,rule,remaining,sentAt,resetAt,receivedAt);
 }
 async snapshot(epoch:string,rules:Array<Omit<QuotaDemand,'amount'>>):Promise<QuotaSnapshot>{
  // Reuse admission validation and key encoding; no admission is created.
  QuotaStore.prepareMany([{store:this,epoch,admissionId:'diagnostic-validation',demands:rules.map(rule=>({...rule,amount:0}))}]);
  const keys=[`${this.prefix}:ready`,`${this.prefix}:blocked`,`${this.prefix}:observed`,...rules.map(rule=>`${this.prefix}:rule:${digest(rule.key)}`)];
  return JSON.parse(String(await this.redis.eval(quotaSnapshotScript,keys.length,...keys,epoch,JSON.stringify(rules)))) as QuotaSnapshot;
 }
 async isReady(epoch:string){
  const state=JSON.parse(String(await this.redis.eval(`${redisGenerationScript}return cjson.encode({run_id=quota_run_id,ready=redis.call('GET',KEYS[1])==(ARGV[1]..':'..quota_run_id)})`,1,`${this.prefix}:ready`,epoch)));
  // Only the reconciler calls this under the PostgreSQL group lock, before replay.
  this.recoveryRunId=state.run_id;return state.ready as boolean;
 }
 async applyExcess(epoch:string,id:string,demand:Pick<QuotaDemand,'key'|'amount'|'window_ms'>,at:number,restore=false){
  if(!epoch||!id||!demand.key||![demand.amount,demand.window_ms,at].every(Number.isSafeInteger)||demand.amount<1||demand.window_ms<1||demand.window_ms>86400000||at<0)throw new Error('invalid_quota_adjustment');
  const identity=digest(id);
  return Number(await this.redis.eval(excessScript,5,`${this.prefix}:ready`,`${this.prefix}:adjustment:${identity}`,`${this.prefix}:rule:${digest(demand.key)}`,`${this.prefix}:observed`,`${this.prefix}:rule:${digest(demand.key)}:aggregate`,epoch,identity,demand.key,demand.amount,at,demand.window_ms,restore?'restore':'apply',this.recoveryRunId??''))===1;
 }
 async currentTime(){const [seconds,microseconds]=await this.redis.time();return Number(seconds)*1000+Math.floor(Number(microseconds)/1000)}
 /** Reconciler-only replay while the gate is closed; original timestamps preserve windows. */
 async restore(admissionId:string,at:number,demands:QuotaDemand[]){
  const rules=demands.map(({key,capacity,amount,window_ms})=>({key,capacity,amount,window_ms})).sort((a,b)=>a.key.localeCompare(b.key));
  const identity=digest(admissionId),fingerprint=digest(JSON.stringify(rules));
  const keys=[`${this.prefix}:admission:${identity}`,...rules.map(rule=>`${this.prefix}:rule:${digest(rule.key)}`),...rules.map(rule=>`${this.prefix}:rule:${digest(rule.key)}:aggregate`)];
  const result=await this.redis.eval(restoreScript,keys.length,...keys,at,identity,fingerprint,JSON.stringify(rules),this.recoveryRunId??'');
  if(Number(result)!==1)throw new Error('quota_restore_failed');
 }
 async close(){await this.redis.quit()}
}
