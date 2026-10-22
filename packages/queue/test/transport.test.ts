import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {ExecutionTransport,deliveryId,redisConnection} from '../src/transport.js';
it('isolates delivery identity by installation, generation and purpose',()=>{
 const d={request_id:'req-a',generation:1,purpose:'execute' as const};
 expect(deliveryId('a',d)).toBe(deliveryId('a',d));
 expect(new Set([deliveryId('a',d),deliveryId('b',d),deliveryId('a',{...d,generation:2}),deliveryId('a',{...d,purpose:'observe'})]).size).toBe(4);
 expect(()=>redisConnection('https://localhost')).toThrow();
});
describe.skipIf(!process.env.REDIS_URL)('Redis transport',()=>{
 it('keeps observation poll revisions distinct while deduplicating a repeated poll',async()=>{
  const transport=new ExecutionTransport(`test-${randomUUID()}`,process.env.REDIS_URL!);
  try{
   const first={request_id:'native-a',generation:0,purpose:'observe' as const,poll_count:0};
   await transport.publish('observe',first);await transport.publish('observe',first);
   await transport.publish('observe',{...first,poll_count:1});
   const jobs=await transport.queue('observe').getJobs(['wait']);
   expect(jobs.map(job=>job.data.poll_count).sort()).toEqual([0,1]);
   await expect(transport.publish('observe',{...first,poll_count:undefined})).rejects.toThrow('invalid_observation_delivery');
   await expect(transport.publish('text',first)).rejects.toThrow('invalid_observation_delivery');
  }finally{await transport.queue('observe').obliterate({force:true});await transport.close()}
 });

 it('pauses intake immediately while allowing an active handler to finish before close',async()=>{
  const transport=new ExecutionTransport(`test-${randomUUID()}`,process.env.REDIS_URL!);
  const entered:string[]=[];let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve});
  transport.consume('text',1,async delivery=>{entered.push(delivery.request_id);await gate},()=>{});
  try{
   await transport.publish('text',{request_id:'active',generation:0,purpose:'execute'});
   await expect.poll(()=>entered).toEqual(['active']);
   await transport.pause();
   await transport.publish('text',{request_id:'waiting',generation:0,purpose:'execute'});
   const closing=transport.close();release();await closing;
   expect(entered).toEqual(['active']);
   expect(()=>transport.consume('text',1,async()=>{},()=>{})).toThrow('transport_stopping');
  }finally{
   release();await transport.close();const cleanup=new ExecutionTransport(transport.installation,process.env.REDIS_URL!);
   expect(await cleanup.queue('text').getWaitingCount()).toBe(1);
   await cleanup.queue('text').obliterate({force:true});await cleanup.close();
  }
 });
 it('delivers concurrently and deduplicates the same durable generation',async()=>{
  const transport=new ExecutionTransport(`test-${randomUUID()}`,process.env.REDIS_URL!);let active=0,peak=0;const ids:string[]=[];const errors:Error[]=[];
  let release!:()=>void;const barrier=new Promise<void>(resolve=>{release=resolve});
  transport.consume('text',2,async d=>{ids.push(d.request_id);active++;peak=Math.max(peak,active);if(active===2)release();await barrier;active--;},e=>errors.push(e));
  try{
   const d={request_id:'first',generation:1,purpose:'execute' as const};
   await Promise.all([transport.publish('text',d),transport.publish('text',d),transport.publish('text',{...d,request_id:'second'})]);
   await expect.poll(async()=>transport.queue('text').getCompletedCount()).toBe(2);
   expect(ids.sort()).toEqual(['first','second']);expect(peak).toBe(2);expect(errors).toEqual([]);
  }finally{release();await transport.close();const cleanup=new ExecutionTransport(transport.installation,process.env.REDIS_URL!);await cleanup.queue('text').obliterate({force:true});await cleanup.close()}
 });
});
