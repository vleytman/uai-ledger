import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {QuotaStore} from '../src/quota.js';
import {typesafeQuotaTemplate} from '../../contracts/src/quota-templates.js';
describe.skipIf(!process.env.REDIS_URL)('Jev shared account RPM/TPS',()=>{
 it('shares capacity across keys/workers and preserves separate windows',async()=>{
  const group=randomUUID(),a=new QuotaStore(process.env.REDIS_URL!,'jev-test',group),b=new QuotaStore(process.env.REDIS_URL!,'jev-test',group);
  try{await Promise.all([a.connect(),b.connect()]);await a.markRestored('epoch');
   const rules=typesafeQuotaTemplate.rules.map(r=>({key:r.key,capacity:Number(r.capacity),amount:r.metric==='tokens'?32768:1,window_ms:r.window_ms}));
   expect(rules.map(r=>r.window_ms)).toEqual([60000,1000]);
   const results=await Promise.all(Array.from({length:9},(_,i)=>(i%2?a:b).acquire('epoch',`key-${i}`,rules)));
   expect(results.filter(r=>r.allowed)).toHaveLength(7);expect(results.filter(r=>!r.allowed).every(r=>!r.allowed&&r.rule==='tps')).toBe(true);
   await expect.poll(async()=>(await b.acquire('epoch','after-tps-window',rules)).allowed).toBe(true);
   const rpmOnly=[{...rules[0],capacity:8}];expect(await a.acquire('epoch','rpm-still-full',rpmOnly)).toMatchObject({allowed:false,rule:'rpm'});
  }finally{await Promise.all([a.close(),b.close()]);}
 });
});
