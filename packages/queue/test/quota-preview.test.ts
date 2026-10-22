import {createHash,randomUUID} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {QuotaStore} from '../src/quota.js';
const url=process.env.REDIS_URL;
describe.skipIf(!url)('Read-only shadow quota calculation',()=>{
 it('does not create permits, prune events, decrement headers or change stored bytes',async()=>{
  const installation=randomUUID(),domain='shadow',store=new QuotaStore(url!,installation,domain);
  const tag=createHash('sha256').update(JSON.stringify([installation,domain])).digest('hex');
  const keys=()=>store.redis.keys(`uai-quota:{${tag}}*`);
  const contents=async()=>Promise.all((await keys()).sort().map(async key=>[key,await store.redis.dump(key)]));
  try{
   await store.connect();const rule={key:'requests',capacity:2,amount:1,window_ms:60000};
   expect(await store.preview('epoch',[rule])).toEqual({would_allow:null,reason:'not_ready'});expect(await keys()).toEqual([]);
   await store.markRestored('epoch');
   // Old entries remain in the zset: a shadow read must not prune or refresh their TTL.
   await store.restore('expired',Date.now()-120000,[rule]);
   const now=await store.currentTime();await store.observe(rule.key,2,now,now+60000);
   const before=await contents();
   for(let i=0;i<3;i++)expect(await store.preview('epoch',[rule])).toEqual({would_allow:true});
   expect(await contents()).toEqual(before);
   expect(await store.acquire('epoch','one',[rule])).toMatchObject({allowed:true,replayed:false});
   const once=await contents();expect(await store.preview('epoch',[rule])).toEqual({would_allow:true});expect(await contents()).toEqual(once);
   expect(await store.acquire('epoch','two',[rule])).toMatchObject({allowed:true,replayed:false});
   const exhausted=await contents(),preview=await store.preview('epoch',[rule]);expect(preview).toMatchObject({would_allow:false,reason:'limited',rule:'requests'});expect(await contents()).toEqual(exhausted);
   const actual=await store.acquire('epoch','three',[rule]);expect(actual).toMatchObject({allowed:false,reason:'limited',rule:'requests'});
   if(!actual.allowed&&preview.would_allow===false)expect(preview.retry_at).toBe(actual.retry_at);
   expect((await keys()).filter(key=>key.includes(':admission:'))).toHaveLength(3); // expired + two actual admissions
  }finally{const owned=await keys();if(owned.length)await store.redis.del(...owned);await store.close()}
 });
 it('evaluates all shared groups atomically and agrees with oversize, headers and cooldown refusal',async()=>{
  const installation=randomUUID(),domain='shared',a=new QuotaStore(url!,installation,'account',domain),b=new QuotaStore(url!,installation,'model',domain);
  const tag=createHash('sha256').update(JSON.stringify([installation,domain])).digest('hex');
  try{
   await Promise.all([a.connect(),b.connect()]);await a.markRestored('v1');await b.markRestored('v1');
   const requests={key:'rpm',capacity:10,amount:1,window_ms:60000},images={key:'images',capacity:1,amount:1,window_ms:86400000};
   const groups=[{store:a,epoch:'v1',demands:[requests]},{store:b,epoch:'v1',demands:[images]}];
   expect(await QuotaStore.previewMany(groups)).toEqual({would_allow:true});
   expect(await QuotaStore.previewMany([{...groups[0]!,demands:[{...requests,amount:11}]},groups[1]!])).toMatchObject({would_allow:false,reason:'too_large',rule:'rpm'});
   await b.block('v1','images',60000);
   const shadow=await QuotaStore.previewMany(groups);expect(shadow).toMatchObject({would_allow:false,reason:'limited',rule:'images'});
   const actual=await QuotaStore.acquireMany(groups.map(group=>({...group,admissionId:'real'})));expect(actual).toMatchObject({allowed:false,reason:'limited',rule:'images'});
   if(shadow.would_allow===false&&!actual.allowed)expect(shadow.retry_at).toBe(actual.retry_at);
   expect(await a.preview('v1',[requests])).toEqual({would_allow:true});
   await b.closeGate();expect(await QuotaStore.previewMany(groups)).toEqual({would_allow:null,reason:'not_ready'});
  }finally{const keys=await a.redis.keys(`uai-quota:{${tag}}*`);if(keys.length)await a.redis.del(...keys);await Promise.all([a.close(),b.close()])}
 });
 it('bounds diagnostic scanning and preserves oversized event history',async()=>{
  const installation=randomUUID(),store=new QuotaStore(url!,installation,'model');
  const tag=createHash('sha256').update(JSON.stringify([installation,'model'])).digest('hex');
  const rule={key:'tokens',capacity:20000,amount:1,window_ms:60000};
  const key=`uai-quota:{${tag}}:rule:${createHash('sha256').update(rule.key).digest('hex')}`;
  try{
   await store.connect();await store.markRestored('v1');const now=await store.currentTime();
   await store.redis.zadd(key,...Array.from({length:10001},(_,i)=>[String(now),`fixture-${i}|1`]).flat());
   const before=await store.redis.dump(key);
   expect(await store.preview('v1',[rule])).toEqual({would_allow:null,reason:'too_many_events'});
   expect(await store.redis.dump(key)).toEqual(before);
   expect(await store.redis.zcard(key)).toBe(10001);
  }finally{const keys=await store.redis.keys(`uai-quota:{${tag}}*`);if(keys.length)await store.redis.del(...keys);await store.close()}
 });
 it('does not treat provider header remaining as full local capacity',async()=>{
  const installation=randomUUID(),store=new QuotaStore(url!,installation,'model');
  const tag=createHash('sha256').update(JSON.stringify([installation,'model'])).digest('hex');
  try{
   await store.connect();await store.markRestored('v1');const now=await store.currentTime(),rule={key:'tokens',capacity:10000,amount:80,window_ms:60000};
   await store.observe('tokens',20,now,now+60000);
   expect(await store.preview('v1',[rule])).toMatchObject({would_allow:false,reason:'limited',rule:'tokens',retry_at:now+60000});
   expect(await store.preview('v1',[{...rule,amount:20}])).toEqual({would_allow:true});
   expect(await store.acquire('v1','actual',[{...rule,amount:20}])).toMatchObject({allowed:true});
   expect(await store.preview('v1',[{...rule,amount:1}])).toMatchObject({would_allow:false,reason:'limited'});
  }finally{const keys=await store.redis.keys(`uai-quota:{${tag}}*`);if(keys.length)await store.redis.del(...keys);await store.close()}
 });
});
