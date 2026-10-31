import {afterAll,describe,it,expect} from 'vitest';
import {createPool,transaction,oncePerTransaction,forgetTransactionWork} from '../src/index.js';
import {lockExecutionAccount} from '../src/execution-lock.js';
import {id} from '../../contracts/src/index.js';

const pool=process.env.DATABASE_URL?createPool():null;
afterAll(async()=>{await pool?.end()});

describe.skipIf(!pool)('work done once per transaction',()=>{
 it('repeats nothing inside one transaction, everything across transactions, and forgets failures and rolled-back savepoints',async()=>{
  let runs=0;const work=async()=>{runs++;return runs};
  await transaction(pool!,async tx=>{
   expect(await oncePerTransaction(tx,'a',work)).toBe(1);expect(await oncePerTransaction(tx,'a',work)).toBe(1);
   await expect(oncePerTransaction(tx,'b',async()=>{throw new Error('failed')})).rejects.toThrow('failed');
   expect(await oncePerTransaction(tx,'b',work)).toBe(2);
   forgetTransactionWork(tx);expect(await oncePerTransaction(tx,'a',work)).toBe(3);
  });
  await transaction(pool!,async tx=>{expect(await oncePerTransaction(tx,'a',work)).toBe(4)});
  // Outside transaction() nothing is remembered.
  expect(await oncePerTransaction(pool! as any,'a',work)).toBe(5);expect(await oncePerTransaction(pool! as any,'a',work)).toBe(6);

  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')};
  const held=(tx:any)=>tx.query("SELECT mode FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() ORDER BY mode");
  await transaction(pool!,async tx=>{
   const statements:string[]=[];const query=tx.query.bind(tx);(tx as any).query=(text:string,values?:any[])=>{statements.push(text);return query(text,values)};
   await lockExecutionAccount(tx,scope);await lockExecutionAccount(tx,scope);await lockExecutionAccount(tx,scope,'shared');
   expect(statements.filter(text=>text.includes('8194'))).toHaveLength(1);
   expect((await held(tx)).rows).toEqual([{mode:'ExclusiveLock'}]);
  });
  // Shared first does not stand in for exclusive.
  await transaction(pool!,async tx=>{
   await lockExecutionAccount(tx,scope,'shared');await lockExecutionAccount(tx,scope);
   expect((await held(tx)).rows).toEqual([{mode:'ExclusiveLock'},{mode:'ShareLock'}]);
  });
 });
});
