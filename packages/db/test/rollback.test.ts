import {expect,test,vi} from 'vitest';
import type pg from 'pg';
import {afterRollback,transaction,type Tx} from '../src/index.js';
test('runs diagnostics after rollback on the same connection and preserves the original error',async()=>{
 const order:string[]=[],original=new Error('original'),client={query:async(sql:string)=>{order.push(sql);return {rows:[]}},release:()=>order.push('release')};
 const pool={connect:async()=>client} as unknown as pg.Pool;
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try{
  await expect(transaction(pool,async tx=>{afterRollback(tx,async db=>{await db.query('diagnostic');throw new Error('private')});throw original})).rejects.toBe(original);
  expect(order).toEqual(['BEGIN','ROLLBACK','diagnostic','release']);expect(log).toHaveBeenCalledExactlyOnceWith('postgres_rollback_diagnostic_failed');
  expect(afterRollback(client as unknown as Tx,async()=>{})).toBe(false);
 }finally{log.mockRestore()}
});
test('does not run rollback observers on commit',async()=>{
 const observer=vi.fn(),client={query:async()=>({rows:[]}),release:vi.fn()};
 expect(await transaction({connect:async()=>client} as unknown as pg.Pool,async tx=>{afterRollback(tx,observer);return 3})).toBe(3);
 expect(observer).not.toHaveBeenCalled();expect(client.release).toHaveBeenCalledOnce();
});
