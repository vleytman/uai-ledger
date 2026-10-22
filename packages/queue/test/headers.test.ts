import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {resetDuration,applyQuotaHeaders} from '../src/headers.js';
import {QuotaStore} from '../src/quota.js';
it('parses reset durations without accepting ambiguous or unbounded values',()=>{
 expect(resetDuration('1m2.5s')).toBe(62500);expect(resetDuration('20ms')).toBe(20);
 for(const v of ['','1','x1s','1s!','-1s','99999d'])expect(resetDuration(v)).toBeUndefined();
});
describe.skipIf(!process.env.REDIS_URL)('provider remaining quota',()=>{
 it('subtracts sends after observation and never increases capacity from a late response',async()=>{
  const store=new QuotaStore(process.env.REDIS_URL!,'test',randomUUID());
  try{await store.connect();await store.markRestored('epoch');const rule={key:'tpm',metric:'tokens',capacity:1000,amount:60,window_ms:60000};const sent=new Date(Date.now()-1000).toISOString();
   await store.acquire('epoch','a',[rule]);
   await applyQuotaHeaders(store,[rule],{sent_at:sent,received_at:new Date().toISOString(),headers:{'x-ratelimit-remaining-tokens':'100','x-ratelimit-reset-tokens':'60s'}});
   expect(await store.acquire('epoch','b',[{...rule,amount:41}])).toMatchObject({allowed:false,reason:'limited'});
   await applyQuotaHeaders(store,[rule],{sent_at:sent,received_at:new Date().toISOString(),headers:{'x-ratelimit-remaining-tokens':'999','x-ratelimit-reset-tokens':'60s'}});
   expect(await store.acquire('epoch','c',[{...rule,amount:41}])).toMatchObject({allowed:false});
   expect(await store.acquire('epoch','d',[{...rule,amount:40}])).toMatchObject({allowed:true});
   expect(await store.acquire('epoch','e',[{...rule,amount:1}])).toMatchObject({allowed:false});
  }finally{await store.close()}
 });
});
