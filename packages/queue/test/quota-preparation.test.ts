import {describe,it,expect,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {Redis} from 'ioredis';
import {QuotaStore} from '../src/quota.js';
const url=process.env.REDIS_URL;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
async function fixture(){
 const domain=randomUUID(),store=new QuotaStore(url!,'test',domain),redis=new Redis(url!);
 await store.connect();await store.markRestored('v1');
 const prefix=`uai-quota:{${hash(JSON.stringify(['test',domain]))}}`;
 const key=(rule:string)=>`${prefix}:rule:${hash(rule)}`;
 const seed=async(rule:string,count:number,at:number)=>{
  const batch=redis.pipeline();for(let i=0;i<count;i++)batch.zadd(key(rule),at+i,`event-${i}|1`);
  const results=await batch.exec();for(const result of results??[])if(result[0])throw result[0];
 };
 return {store,redis,key,prefix,seed,close:async()=>{vi.restoreAllMocks();await store.close();await redis.quit()}};
}
describe.skipIf(!url)('bounded quota preparation',()=>{
 it('rechecks earlier rules after a concurrent correction while a later rule is rebuilding',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime();await f.seed('z',10000,now-20000);
   const demands=[{key:'a',capacity:1,amount:1,window_ms:60000},{key:'z',capacity:20000,amount:1,window_ms:60000}];
   const original=f.store.redis.eval.bind(f.store.redis);let injected=false,passes=0;
   vi.spyOn(f.store.redis,'eval').mockImplementation(async(...args:Parameters<typeof original>)=>{
    const result=await original(...args);
    if(typeof result==='string'&&JSON.parse(result).reason==='preparing'){
     passes++;
     if(!injected){injected=true;await f.store.applyExcess('v1','concurrent',{key:'a',amount:1,window_ms:60000},await f.store.currentTime())}
    }
    return result;
   });
   expect(await f.store.acquire('v1','candidate',demands)).toMatchObject({allowed:false,reason:'limited',rule:'a'});
   expect(passes).toBeGreaterThan(0);expect(injected).toBe(true);
   expect(await f.redis.get(`${f.prefix}:admission:${hash('candidate')}`)).toBeNull();
   expect(await f.redis.zcard(f.key('a'))).toBe(1);expect(await f.redis.zcard(f.key('z'))).toBe(10000);
  }finally{await f.close()}
 });
 it('invalidates a partial cold sum when restored history changes between pages',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime();await f.seed('tokens',10000,now-20000);
   const rule={key:'tokens',capacity:10001,amount:1,window_ms:60000};
   const original=f.store.redis.eval.bind(f.store.redis);let injected=false;
   vi.spyOn(f.store.redis,'eval').mockImplementation(async(...args:Parameters<typeof original>)=>{
    const result=await original(...args);
    if(!injected&&typeof result==='string'&&JSON.parse(result).reason==='preparing'){
     injected=true;await f.store.restore('recovered',now,[rule]);
    }
    return result;
   });
   expect(await f.store.acquire('v1','candidate',[rule])).toMatchObject({allowed:false,reason:'limited',details:{available:'0'}});
   expect(injected).toBe(true);expect(await f.redis.hget(`${f.key('tokens')}:aggregate`,'used')).toBe('10001');
   expect(await f.redis.zcard(f.key('tokens'))).toBe(10001);
  }finally{await f.close()}
 });
 it('resumes a long denial and discards its checkpoint after usage changes',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime();await f.seed('tokens',10000,now-20000);
   const rule={key:'tokens',capacity:10000,amount:10000,window_ms:60000};
   await f.store.acquire('v1','warm',[{...rule,amount:0}]);
   const original=f.store.redis.eval.bind(f.store.redis);let injected=false;
   vi.spyOn(f.store.redis,'eval').mockImplementation(async(...args:Parameters<typeof original>)=>{
    const result=await original(...args);
    if(!injected&&typeof result==='string'&&JSON.parse(result).reason==='preparing'){
     injected=true;await f.store.applyExcess('v1','late',{...rule,amount:1},now);
    }
    return result;
   });
   expect(await f.store.acquire('v1','candidate',[rule])).toMatchObject({allowed:false,reason:'limited',retry_at:now+60000});
   expect(injected).toBe(true);expect(await f.redis.hget(`${f.key('tokens')}:aggregate`,'used')).toBe('10001');
  }finally{await f.close()}
 });
 it('stops preparation without a permit at its deadline and resumes the same intent',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime();await f.seed('tokens',5000,now-10000);
   const rule={key:'tokens',capacity:5001,amount:1,window_ms:60000};
   const clock=vi.spyOn(performance,'now').mockReturnValueOnce(0).mockReturnValue(20001);
   expect(await f.store.acquire('v1','candidate',[rule])).toEqual({allowed:false,reason:'not_ready'});
   clock.mockRestore();
   expect(await f.redis.get(`${f.prefix}:admission:${hash('candidate')}`)).toBeNull();
   expect(await f.redis.zcard(f.key('tokens'))).toBe(5000);
   expect(await f.store.acquire('v1','candidate',[rule])).toMatchObject({allowed:true,replayed:false});
   expect(await f.store.acquire('v1','candidate',[rule])).toMatchObject({allowed:true,replayed:true});
   expect(await f.redis.zcard(f.key('tokens'))).toBe(5001);
  }finally{await f.close()}
 });
 it('preserves safe integer weights across serialized preparation checkpoints',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime(),weight=100000000003,total=5000*weight;
   const batch=f.redis.pipeline();for(let i=0;i<5000;i++)batch.zadd(f.key('tokens'),now-10000+i,`event-${i}|${weight}`);await batch.exec();
   const rule={key:'tokens',capacity:total,amount:total,window_ms:60000};
   expect(await f.store.acquire('v1','candidate',[rule])).toMatchObject({allowed:false,reason:'limited',retry_at:now-10000+4999+60000});
   expect(await f.redis.hget(`${f.key('tokens')}:aggregate`,'used')).toBe(String(total));
  }finally{await f.close()}
 });
 it('bounds a read-only preview across all rules and does not create aggregates',async()=>{
  const f=await fixture();try{
   const now=await f.store.currentTime();await f.seed('a',6000,now-20000);await f.seed('b',6000,now-20000);
   const rules=['a','b'].map(key=>({key,capacity:10000,amount:1,window_ms:60000}));
   expect(await f.store.preview('v1',rules)).toEqual({would_allow:null,reason:'too_many_events'});
   expect(await f.redis.exists(`${f.key('a')}:aggregate`,`${f.key('b')}:aggregate`)).toBe(0);
   expect(await f.redis.zcard(f.key('a'))).toBe(6000);
  }finally{await f.close()}
 });
});
