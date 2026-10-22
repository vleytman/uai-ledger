import {afterAll,describe,it,expect} from 'vitest';
import {createPool} from '../../db/src/index.js';
import {ManualClock,id} from '../../contracts/src/index.js';
import {ExecutionTransport,deliveryId,type Delivery} from '../src/transport.js';
import {executeMaintenance,relayMaintenance} from '../src/maintenance.js';
const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});
describe.skipIf(!pool||!process.env.REDIS_URL)('maintenance cycles',()=>{
 it('recovers lost delivery and serializes a cycle without losing its next generation',async()=>{
  const installation=id('maintenance'),transport=new ExecutionTransport(installation,process.env.REDIS_URL!),clock=new ManualClock(new Date());
  const delivery:Delivery={request_id:installation,generation:0,purpose:'maintenance'};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let calls=0;
  try{
   expect((await Promise.all([relayMaintenance(pool!,transport,clock),relayMaintenance(pool!,transport,clock)])).filter(Boolean)).toHaveLength(1);
   await (await transport.queue('maintenance').getJob(deliveryId(installation,delivery)))!.remove();clock.advance(5000);
   expect(await relayMaintenance(pool!,transport,clock)).toBe(true);
   expect(await transport.queue('maintenance').getWaitingCount()).toBe(1);
   const first=executeMaintenance(pool!,installation,delivery,async()=>{calls++;await gate},clock);
   await expect.poll(()=>calls).toBe(1);
   expect(await executeMaintenance(pool!,installation,delivery,async()=>{calls++},clock)).toEqual({worked:false});
   release();expect((await first).worked).toBe(true);
   expect(await executeMaintenance(pool!,installation,delivery,async()=>{calls++},clock)).toEqual({worked:false});
   clock.advance(1000);expect(await relayMaintenance(pool!,transport,clock)).toBe(true);
   const next={...delivery,generation:1};
   await expect(executeMaintenance(pool!,installation,next,async()=>{throw new Error('temporary failure')},clock)).rejects.toThrow('temporary failure');
   expect((await pool!.query('SELECT generation FROM execution_maintenance_cycles WHERE installation_id=$1',[installation])).rows[0].generation).toBe(1);
   expect(await executeMaintenance(pool!,installation,next,async()=>{calls++},clock)).toEqual({worked:false});
   clock.advance(5000);expect((await executeMaintenance(pool!,installation,next,async()=>{calls++},clock)).worked).toBe(true);
   expect(calls).toBe(2);
  }finally{release();await transport.queue('maintenance').obliterate({force:true});await transport.close();await pool!.query('DELETE FROM execution_maintenance_cycles WHERE installation_id=$1',[installation]);}
 });
 it('does not let an expired owner advance a cycle reclaimed by another worker',async()=>{
  const installation=id('maintenance'),transport=new ExecutionTransport(installation,process.env.REDIS_URL!),clock=new ManualClock(new Date());
  const delivery:Delivery={request_id:installation,generation:0,purpose:'maintenance'};
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});let started=false;
  try{
   await relayMaintenance(pool!,transport,clock);
   const stale=executeMaintenance(pool!,installation,delivery,async()=>{started=true;await gate},clock);
   const rejected=expect(stale).rejects.toThrow('maintenance_lease_lost');
   await expect.poll(()=>started).toBe(true);clock.advance(30001);
   expect((await executeMaintenance(pool!,installation,delivery,async()=>{},clock)).worked).toBe(true);
   release();await rejected;
   expect((await pool!.query('SELECT generation FROM execution_maintenance_cycles WHERE installation_id=$1',[installation])).rows[0].generation).toBe(1);
  }finally{release();await transport.queue('maintenance').obliterate({force:true});await transport.close();await pool!.query('DELETE FROM execution_maintenance_cycles WHERE installation_id=$1',[installation]);}
 });
});
