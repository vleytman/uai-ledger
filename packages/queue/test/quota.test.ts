import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {QuotaStore} from '../src/quota.js';
const url=process.env.REDIS_URL;
describe.skipIf(!url)('atomic distributed quota',()=>{
 it('admits only one contender and rejects the whole vector without partial consumption',async()=>{
  const name=randomUUID(),a=new QuotaStore(url!,'test',name),b=new QuotaStore(url!,'test',name);
  try{
   await Promise.all([a.connect(),b.connect()]);await a.markRestored('epoch');
   const rules=[{key:'requests',capacity:1,amount:1,window_ms:60000},{key:'tokens',capacity:100,amount:80,window_ms:60000}];
   const results=await Promise.all([a.acquire('epoch','a',rules),b.acquire('epoch','b',rules)]);
   expect(results.filter(r=>r.allowed)).toHaveLength(1);
   expect(results.find(r=>!r.allowed)).toMatchObject({reason:'limited',rule:'requests'});
   const remainder=await a.acquire('epoch','remaining',[{key:'tokens',capacity:100,amount:20,window_ms:60000}]);expect(remainder.allowed).toBe(true);
  }finally{await Promise.all([a.close(),b.close()])}
 });
 it('deduplicates permits, refuses oversized work and fails closed after losing the epoch',async()=>{
  const store=new QuotaStore(url!,'test',randomUUID());
  try{await store.connect();const rule={key:'images',capacity:2,amount:1,window_ms:60000};
   expect(await store.acquire('epoch','a',[rule])).toEqual({allowed:false,reason:'not_ready'});
   await store.markRestored('epoch');expect(await store.acquire('epoch','oversize',[{...rule,amount:3}])).toMatchObject({allowed:false,reason:'too_large'});
   const first=await store.acquire('epoch','a',[rule]);expect(first.allowed).toBe(true);
   expect(await store.acquire('epoch','a',[rule])).toMatchObject({allowed:true,replayed:true});
   expect(await store.acquire('epoch','a',[{...rule,amount:2}])).toMatchObject({allowed:false,reason:'conflict'});
   expect((await store.acquire('epoch','b',[rule])).allowed).toBe(true);
   expect((await store.acquire('epoch','c',[rule])).allowed).toBe(false);
   await store.closeGate();expect(await store.acquire('epoch','a',[rule])).toMatchObject({reason:'not_ready'});
  }finally{await store.close()}
 });
 it('applies provider cooldown to its rule only and releases capacity as the window expires',async()=>{
  const store=new QuotaStore(url!,'test',randomUUID());
  try{await store.connect();await store.markRestored('epoch');
   const rule={key:'text',capacity:1,amount:1,window_ms:150};
   expect((await store.acquire('epoch','a',[rule])).allowed).toBe(true);
   expect(await store.acquire('epoch','b',[rule])).toMatchObject({allowed:false,reason:'limited'});
   await expect.poll(async()=> (await store.acquire('epoch','b',[rule])).allowed).toBe(true);
   await store.block('epoch','images',1000);
   expect(await store.acquire('epoch','c',[{...rule,key:'images'}])).toMatchObject({allowed:false,rule:'images'});
   expect((await store.acquire('epoch','d',[{...rule,key:'other'}])).allowed).toBe(true);
  }finally{await store.close()}
 });
});
describe.skipIf(!url)('quota restoration',()=>{
 it('does not shorten a newer recovery window when an old restore arrives late',async()=>{
  const name=randomUUID(),old=new QuotaStore(url!,'test',name),current=new QuotaStore(url!,'test',name);
  try{
   await Promise.all([old.connect(),current.connect()]);
   const rule={key:'requests',capacity:1,amount:1,window_ms:60000},now=await current.currentTime();
   await current.restore('uncertain',now,[rule]);await current.markRestored('epoch');
   // A former owner resumes a command captured before the new recovery snapshot.
   await old.restore('uncertain',now-120000,[rule]);
   expect(await current.acquire('epoch','uncertain',[rule])).toMatchObject({allowed:true,replayed:true,at:now});
   expect(await current.acquire('epoch','next',[rule])).toMatchObject({allowed:false,reason:'limited'});
  }finally{await Promise.all([old.close(),current.close()])}
 });

 it('restores weighted consumption with its original expiry, without granting a fresh window',async()=>{
  const store=new QuotaStore(url!,'test',randomUUID());
  try{await store.connect();const rule={key:'tokens',capacity:100,amount:80,window_ms:5000};
   await store.restore('old',Date.now(),[rule]);
   expect(await store.acquire('new-epoch','next',[rule])).toMatchObject({reason:'not_ready'});
   await store.markRestored('new-epoch');expect(await store.acquire('new-epoch','next',[rule])).toMatchObject({reason:'limited'});
   expect(await store.acquire('new-epoch','remainder',[{...rule,amount:20}])).toMatchObject({allowed:true});
  }finally{await store.close()}
 });
});

describe.skipIf(!url)('atomic admission across quota groups',()=>{
 it('arbitrates a shared account and model limit in one operation, without partial debits',async()=>{
  const domain=randomUUID(),account=new QuotaStore(url!,'test','account',domain),model=new QuotaStore(url!,'test','model',domain);
  try{
   await Promise.all([account.connect(),model.connect()]);await account.markRestored('account-v1');await model.markRestored('model-v1');
   const accountRule={key:'rpm',capacity:2,amount:1,window_ms:60000},modelRule={...accountRule,capacity:1};
   const inputs=(admissionId:string)=>[{store:account,epoch:'account-v1',admissionId,demands:[accountRule]},{store:model,epoch:'model-v1',admissionId,demands:[modelRule]}];
   const results=await Promise.all([QuotaStore.acquireMany(inputs('first')),QuotaStore.acquireMany(inputs('second'))]);
   expect(results.filter(result=>result.allowed)).toHaveLength(1);
   expect(results.find(result=>!result.allowed)).toMatchObject({reason:'limited',details:{group_id:'model',rule:'rpm',demand:'1',available:'0',capacity:'1',window_ms:60000}});
   const winner=results[0]!.allowed?'first':'second';
   expect(await QuotaStore.acquireMany(inputs(winner))).toMatchObject({allowed:true,replayed:true});
   expect(await account.acquire('account-v1','unused-account-slot',[accountRule])).toMatchObject({allowed:true});
   expect(await account.acquire('account-v1','exhausted',[accountRule])).toMatchObject({allowed:false,reason:'limited'});
  }finally{await Promise.all([account.close(),model.close()])}
 });
 it('fails closed on missing group recovery and mixed prior permits without charging other groups',async()=>{
  const domain=randomUUID(),a=new QuotaStore(url!,'test','a',domain),b=new QuotaStore(url!,'test','b',domain);
  try{
   await Promise.all([a.connect(),b.connect()]);await a.markRestored('v1');
   const rule={key:'requests',capacity:1,amount:1,window_ms:60000};
   const inputs=[{store:a,epoch:'v1',admissionId:'shared',demands:[rule]},{store:b,epoch:'v1',admissionId:'shared',demands:[rule]}];
   expect(await QuotaStore.acquireMany(inputs)).toMatchObject({allowed:false,reason:'not_ready'});
   expect(await a.acquire('v1','shared',[rule])).toMatchObject({allowed:true});
   await b.markRestored('v1');
   expect(await QuotaStore.acquireMany(inputs)).toMatchObject({allowed:false,reason:'conflict'});
   expect(await b.acquire('v1','independent',[rule])).toMatchObject({allowed:true});
  }finally{await Promise.all([a.close(),b.close()])}
 });
 it('rejects groups outside one Redis coordination domain before executing Lua',async()=>{
  const a=new QuotaStore(url!,'test',randomUUID()),b=new QuotaStore(url!,'test',randomUUID());
  try{
   await Promise.all([a.connect(),b.connect()]);
   const input={epoch:'v1',admissionId:'id',demands:[{key:'rpm',capacity:1,amount:1,window_ms:60000}]};
   await expect(QuotaStore.acquireMany([{...input,store:a},{...input,store:b}])).rejects.toThrow('quota_domains_must_match');
   await expect(QuotaStore.acquireMany([{...input,store:a},{...input,store:a}])).rejects.toThrow('duplicate_quota_group');
  }finally{await Promise.all([a.close(),b.close()])}
 });
});
