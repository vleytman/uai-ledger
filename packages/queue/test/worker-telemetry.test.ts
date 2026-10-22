import {it,expect} from 'vitest';
import {WorkerTelemetry} from '../src/worker-telemetry.js';
it('measures allowed, denied and failed admission without changing return values or errors',async()=>{
 let now=0;const metrics=new WorkerTelemetry(async()=>{},async()=>{},()=>now);
 const allowed={allowed:true,id:'permit'};expect(await metrics.admit('text',async()=>{now+=10;return allowed})).toBe(allowed);
 expect(await metrics.admit('text',async()=>{now+=20;return {allowed:false}})).toEqual({allowed:false});
 const error=new Error('database unavailable');await expect(metrics.admit('text',async()=>{now+=30;throw error})).rejects.toBe(error);
 expect(metrics.snapshot('text')).toMatchObject({admission_ms:[10,20,30],admission_denied:1,admission_errors:1});
 expect(metrics.snapshot('image').admission_ms).toEqual([]);
});
it('bounds samples to 256 per queue and expires them without treating missing probes as zero',async()=>{
 let now=0;const metrics=new WorkerTelemetry(async()=>{},async()=>{},()=>now);
 for(let n=0;n<300;n++)await metrics.admit('text',async()=>{now++;return {allowed:true}});
 expect(metrics.snapshot('text').admission_ms).toHaveLength(256);expect(metrics.snapshot('text').db).toEqual({state:'pending',ms:null});
 now+=900001;expect(metrics.snapshot('text').admission_ms).toEqual([]);
});
it('records independent probe failures and recovers without exposing error details',async()=>{
 let now=0,fail=true;const metrics=new WorkerTelemetry(async()=>{now+=5},async()=>{if(fail)throw new Error('private endpoint');now+=2},()=>now);
 await metrics.probe();expect(metrics.snapshot('text')).toMatchObject({db:{state:'ok'},redis:{state:'failed',ms:null}});
 fail=false;await metrics.probe();expect(metrics.snapshot('text').redis).toEqual({state:'ok',ms:2});
});
