import {describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {Redis} from 'ioredis';
import {QuotaStore} from '../src/quota.js';
const url=process.env.REDIS_URL;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const rule={key:'tokens',capacity:100,amount:40,window_ms:60000};
async function fixture(){
 const domain=randomUUID(),store=new QuotaStore(url!,'test',domain),redis=new Redis(url!);
 await store.connect();await store.markRestored('v1');
 const key=`uai-quota:{${hash(JSON.stringify(['test',domain]))}}:rule:${hash(rule.key)}`;
 return {store,redis,key,close:async()=>{await store.close();await redis.quit()}};
}
describe.skipIf(!url)('derived quota aggregates',()=>{
 it('rebuilds after cache loss without forgetting existing consumption',async()=>{
  const f=await fixture();try{
   expect(await f.store.acquire('v1','first',[rule])).toMatchObject({allowed:true});
   await f.redis.del(`${f.key}:aggregate`);
   expect(await f.store.acquire('v1','second',[rule])).toMatchObject({allowed:true});
   expect(await f.store.acquire('v1','denied',[rule])).toMatchObject({allowed:false,reason:'limited',details:{available:'20'}});
   await f.redis.del(`${f.key}:aggregate`);
   expect(await f.store.acquire('v1','third',[{...rule,amount:20}])).toMatchObject({allowed:true});
   expect(await f.store.snapshot('v1',[rule])).toMatchObject({ready:true,rules:[{used:'100'}]});
  }finally{await f.close()}
 });
 it('invalidates cached totals for excess usage and unsent permit refunds',async()=>{
  const f=await fixture();try{
   await f.store.acquire('v1','first',[rule]);
   const at=await f.store.currentTime();
   expect(await f.store.applyExcess('v1','extra',{...rule,amount:30},at)).toBe(true);
   expect(await f.store.acquire('v1','denied',[rule])).toMatchObject({allowed:false,reason:'limited',details:{available:'30'}});
   expect(await QuotaStore.discardUnsentMany([{store:f.store,epoch:'v1',admissionId:'first',demands:[rule]}])).toBe(true);
   expect(await f.store.acquire('v1','second',[rule])).toMatchObject({allowed:true});
   expect(await f.store.acquire('v1','second',[rule])).toMatchObject({allowed:true,replayed:true});
   expect(await f.store.snapshot('v1',[rule])).toMatchObject({ready:true,rules:[{used:'70'}]});
  }finally{await f.close()}
 });
 it('subtracts exactly expired events from a warm aggregate',async()=>{
  const f=await fixture();try{
   const short={...rule,capacity:40,window_ms:1000};
   await f.store.restore('old',(await f.store.currentTime())-500,[short]);
   expect(await f.store.acquire('v1','next',[short])).toMatchObject({allowed:false,reason:'limited'});
   await vi.waitFor(async()=>expect(await f.store.acquire('v1','next',[short])).toMatchObject({allowed:true}),{timeout:3000,interval:50});
   expect(await f.store.snapshot('v1',[short])).toMatchObject({ready:true,rules:[{used:'40'}]});
  }finally{await f.close()}
 });
 it('finds the exact retry beyond the first page of weighted expirations',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime();
   const demand={...rule,capacity:600,amount:0};
   const entries=Array.from({length:300},(_,i)=>[now-10000+i,`event-${i}|2`]).flat();
   await f.redis.zadd(f.key,...entries);
   await f.store.acquire('v1','warm',[demand]);
   const denied=await f.store.acquire('v1','large',[{...demand,amount:400}]);
   expect(denied).toMatchObject({allowed:false,reason:'limited',retry_at:now-10000+199+rule.window_ms,details:{available:'0'}});
   expect(await f.store.snapshot('v1',[demand])).toMatchObject({ready:true,rules:[{used:'600'}]});
  }finally{await f.close()}
 });
 it('clears a completely expired set and keeps the new permit counted',async()=>{
  const f=await fixture();try{
   await f.store.acquire('v1','first',[rule]);
   const old=(await f.store.currentTime())-rule.window_ms-1000;
   const members=await f.redis.zrange(f.key,0,-1);
   await f.redis.zadd(f.key,old,members[0]!);
   expect(await f.store.acquire('v1','new',[rule])).toMatchObject({allowed:true});
   expect(await f.redis.zcard(f.key)).toBe(1);
   expect(await f.store.acquire('v1','another',[rule])).toMatchObject({allowed:true});
   expect(await f.store.acquire('v1','full',[rule])).toMatchObject({allowed:false,reason:'limited',details:{available:'20'}});
  }finally{await f.close()}
 });
 it('rebuilds when a window changes and after restoring new history',async()=>{
  const f=await fixture();try{
   await f.store.restore('old',(await f.store.currentTime())-5000,[rule]);
   await f.store.acquire('v1','warm',[{...rule,amount:0}]);
   expect(await f.redis.hget(`${f.key}:aggregate`,'used')).toBe('40');
   expect(await f.store.acquire('v1','short',[{...rule,window_ms:1000}])).toMatchObject({allowed:true});
   await f.store.restore('recovered',await f.store.currentTime(),[{...rule,amount:60,window_ms:1000}]);
   expect(await f.store.acquire('v1','full',[{...rule,window_ms:1000}])).toMatchObject({allowed:false,reason:'limited',details:{available:'0'}});
   expect(await f.store.snapshot('v1',[{...rule,window_ms:1000}])).toMatchObject({ready:true,rules:[{used:'100'}]});
  }finally{await f.close()}
 });
});
