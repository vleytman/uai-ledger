import {EventEmitter} from 'node:events';
import {it,expect,vi} from 'vitest';
import {SchedulerWakeup} from '../src/wakeup.js';
it('coalesces notifications, falls back after timeout and reconnects after listener loss',async()=>{
 vi.useFakeTimers();
 const clients:any[]=[];const pool={connect:async()=>{const client=Object.assign(new EventEmitter(),{query:vi.fn(async()=>{}),release:vi.fn()});clients.push(client);return client}};
 const wakeup=new SchedulerWakeup(pool as any);
 try{
  await wakeup.connect();expect(clients[0].query).toHaveBeenCalledWith('LISTEN uai_scheduler');
  clients[0].emit('notification',{channel:'uai_scheduler'});clients[0].emit('notification',{channel:'uai_scheduler'});
  await wakeup.wait();let done=false;const waiting=wakeup.wait().then(()=>done=true);
  await vi.advanceTimersByTimeAsync(999);expect(done).toBe(false);await vi.advanceTimersByTimeAsync(1);await waiting;expect(done).toBe(true);
  const interrupted=wakeup.wait();clients[0].emit('error',new Error('connection lost'));await interrupted;expect(clients[0].release).toHaveBeenCalledWith(true);
  await wakeup.connect();expect(clients).toHaveLength(2);
  const notified=wakeup.wait();clients[1].emit('notification',{channel:'uai_scheduler'});await notified;
 }finally{await wakeup.close();vi.useRealTimers()}
 expect(clients[1].query).toHaveBeenCalledWith('UNLISTEN uai_scheduler');
});
it.skipIf(!process.env.DATABASE_URL)('outbox wakeup is committed with its row and a rolled-back notification never escapes',async()=>{
 const {createPool,emit}=await import('../src/index.js');const {id}=await import('../../contracts/src/index.js');const pool=createPool(),listener=await pool.connect(),writer=await pool.connect();
 const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},received:any[]=[];
 listener.on('notification',event=>{if(event.channel==='uai_transient'){const value=JSON.parse(event.payload??'{}');if(value.organization_id===scope.organization_id)received.push(value)}});
 try{
  await listener.query('LISTEN uai_transient');await writer.query('BEGIN');await emit(writer,scope,'wallet.updated',{type:'wallet',id:'fixture'},{private:'not in notification'});
  await new Promise(resolve=>setTimeout(resolve,30));expect(received).toEqual([]);await writer.query('ROLLBACK');
  await writer.query('BEGIN');await emit(writer,scope,'wallet.updated',{type:'wallet',id:'fixture'},{revision:2});await writer.query('COMMIT');
  await vi.waitFor(()=>expect(received).toHaveLength(1));expect(received[0]).toEqual({type:'outbox_wakeup',...scope});expect((await pool.query('SELECT count(*)::int n FROM outbox_events WHERE organization_id=$1',[scope.organization_id])).rows[0].n).toBe(1);
 }finally{await writer.query('ROLLBACK');await listener.query('UNLISTEN uai_transient');writer.release();listener.release();await pool.end()}
});
