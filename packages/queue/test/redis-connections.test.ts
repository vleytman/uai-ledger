import {describe,it,expect} from 'vitest';
import {id} from '../../contracts/src/index.js';
import {ExecutionTransport} from '../src/transport.js';
import {QuotaStore} from '../src/quota.js';
import {LoadRedisMetrics} from '../../../scripts/load/redis-metrics.js';

describe.skipIf(!process.env.REDIS_URL)('Installation Redis connection accounting',()=>{
 it('includes BullMQ duplicates and quota clients, excludes foreign clients, and observes cleanup',async()=>{
  const url=process.env.REDIS_URL!,installation=id('connections');
  const metrics=new LoadRedisMetrics(url,installation),transport=new ExecutionTransport(installation,url);
  const own=new QuotaStore(url,installation,'quota'),foreign=new QuotaStore(url,installation+'-other','quota');
  let closed=false;const errors:Error[]=[];
  try{
   await metrics.connect();await own.connect();await foreign.connect();
   await transport.queue('text').waitUntilReady();
   await transport.consume('text',1,async()=>{},error=>errors.push(error)).waitUntilReady();
   // The blocking duplicate connects independently of the worker's main client.
   await expect.poll(async()=>(await metrics.sample()).installation_connections).toBe(4);
   await expect.poll(async()=>(await metrics.sample()).blocking_connections).toBe(1);
   const sample=await metrics.sample();
   expect(sample).toMatchObject({installation_connections:4,quota_connections:1,monitor_connections:1});
   expect(sample.server_connections).toBeGreaterThanOrEqual(6);
   await transport.close();await own.close();closed=true;
   await expect.poll(async()=>(await metrics.sample()).installation_connections).toBe(0);
   expect(errors).toEqual([]);
  }finally{if(!closed){await transport.close();await own.close()}await foreign.close();metrics.close()}
 });
});
