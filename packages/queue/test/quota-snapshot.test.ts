import {describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {QuotaStore} from '../src/quota.js';
const url=process.env.REDIS_URL;
describe.skipIf(!url)('Read-only quota diagnostics',()=>{
 it('bounds diagnostic scans and ignores expired provider observations',async()=>{
  const group=randomUUID(),store=new QuotaStore(url!,'test',group),rule={key:'rpm',capacity:20000,window_ms:60000};
  try{
   await store.connect();await store.markRestored('epoch');const now=await store.currentTime();
   await store.observe(rule.key,0,now-5000,now-1,now-4000);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{available:'20000',provider:null}]});
   const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
   const key=`uai-quota:{${digest(JSON.stringify(['test',group]))}}:rule:${digest(rule.key)}`;
   await store.redis.zadd(key,...Array.from({length:10001},(_,i)=>[String(now),`${i}|1`]).flat());await store.redis.pexpire(key,60000);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:false,reason:'too_many_events'});
   expect(await store.redis.zcard(key)).toBe(10001);
  }finally{await store.close()}
 });
 it('does not invent free quota before recovery, and accounts for expiry without pruning events',async()=>{
  const group=randomUUID(),store=new QuotaStore(url!,'test',group),rule={key:'tokens',capacity:100,window_ms:60000};
  try{
   await store.connect();expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:false,reason:'not_ready'});
   expect(await store.isReady('epoch')).toBe(false);
   const now=await store.currentTime();
   await store.restore('expired',now-61000,[{...rule,amount:60}]);await store.restore('active',now,[{...rule,amount:70}]);await store.markRestored('epoch');
   const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
   const eventKey=`uai-quota:{${digest(JSON.stringify(['test',group]))}}:rule:${digest(rule.key)}`;
   const before=await store.redis.zrange(eventKey,0,-1,'WITHSCORES');expect(before).toHaveLength(4);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{key:'tokens',used:'70',local_remaining:'30',available:'30',provider:null,blocked_until:null}]});
   expect(await store.redis.zrange(eventKey,0,-1,'WITHSCORES')).toEqual(before);
   expect(await store.snapshot('other-epoch',[rule])).toMatchObject({ready:false,reason:'not_ready'});
   expect(await store.snapshot('epoch',[{...rule,capacity:50}])).toMatchObject({ready:true,rules:[{used:'70',local_remaining:'0',available:'0'}]});
   expect(await store.acquire('epoch','last',[{...rule,amount:30}])).toMatchObject({allowed:true});
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'100',available:'0'}]});
  }finally{await store.close()}
 });
 it('separates local remainder from conservative provider availability and preserves observation dates',async()=>{
  const store=new QuotaStore(url!,'test',randomUUID()),rule={key:'rpm',capacity:100,window_ms:60000};
  try{
   await store.connect();await store.markRestored('epoch');const now=await store.currentTime();
   await store.observe(rule.key,40,now-10000,now+60000,now-5000);
   await store.observe(rule.key,90,now-20000,now+50000,now-10000);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'0',local_remaining:'100',available:'40',provider:{remaining:'40',reset_at:now+60000,observed_at:now-5000}}]});
   await store.acquire('epoch','a',[{...rule,amount:5}]);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'5',local_remaining:'95',available:'35',provider:{remaining:'35',observed_at:now-5000}}]});
   await store.blockUntil('epoch',rule.key,now+30000);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{local_remaining:'95',available:'0',blocked_until:now+30000}]});
   // Replay must not present old headers as an observation received just now.
   await store.observe(rule.key,90,now-20000,now+50000,now-10000);
   expect(await store.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{provider:{observed_at:now-5000}}]});
  }finally{await store.close()}
 });
 it('keeps coordinated group and installation diagnostics isolated',async()=>{
  const domain=randomUUID(),a=new QuotaStore(url!,'test','a',domain),b=new QuotaStore(url!,'test','b',domain),other=new QuotaStore(url!,'other','a',domain),rule={key:'rpm',capacity:10,window_ms:60000};
  try{
   await Promise.all([a.connect(),b.connect(),other.connect()]);await a.markRestored('epoch');await b.markRestored('epoch');
   await a.acquire('epoch','a',[{...rule,amount:4}]);
   expect(await a.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'4'}]});
   expect(await b.snapshot('epoch',[rule])).toMatchObject({ready:true,rules:[{used:'0'}]});
   expect(await other.snapshot('epoch',[rule])).toMatchObject({ready:false,reason:'not_ready'});
  }finally{await Promise.all([a.close(),b.close(),other.close()])}
 });
});
