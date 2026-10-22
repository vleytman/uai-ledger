import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {isolatedTestDatabase} from '../../../packages/db/test/isolated-database.js';
import {transaction} from '../../../packages/db/src/index.js';
import {lockExecutionAccount} from '../../../packages/db/src/execution-lock.js';
import {issueToken} from '../../../packages/auth/src/index.js';
import {ensureWallet,grant} from '../../../packages/accounting/src/index.js';
import {id,systemClock} from '../../../packages/contracts/src/index.js';
import {createApi} from './server.js';
const database=isolatedTestDatabase(process.env.DATABASE_URL);
beforeAll(async()=>{if(process.env.DATABASE_URL)await database.initialize()});
afterAll(async()=>{await database.close()});
describe.skipIf(!process.env.DATABASE_URL)('Independent administrative financial snapshots',()=>{
 it('releases the earlier wallet while the list waits for another account',async()=>{
  const pool=database.pool!,scope={organization_id:id('org'),application_id:id('app')};
  await pool.query('INSERT INTO applications(id,organization_id,name) VALUES($1,$2,$1)',[scope.application_id,scope.organization_id]);
  for(let i=0;i<2;i++)await transaction(pool,async tx=>{
   const account_id=id('account');await tx.query('INSERT INTO accounts(id,organization_id,application_id,external_account_id) VALUES($1,$2,$3,$1)',[account_id,scope.organization_id,scope.application_id]);await ensureWallet(tx,{...scope,account_id});
  });
  const wallets=(await pool.query('SELECT id,account_id FROM wallets WHERE application_id=$1 ORDER BY id',[scope.application_id])).rows;
  const token=await transaction(pool,tx=>issueToken(tx,{...scope,scopes:['operations:admin'],account_ids:null,max_grant_units:null,expires_at:null}));
  const held=await pool.connect(),app=createApi(pool);
  let response:Promise<Awaited<ReturnType<typeof app.inject>>>|undefined;
  try{
   await held.query('BEGIN');await ensureWallet(held,{...scope,account_id:wallets[1].account_id});
   const pid=(await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
   response=app.inject({method:'GET',url:'/v1/admin/wallets',headers:{authorization:`Bearer ${token.token}`}});
   await expect.poll(async()=>(await pool.query('SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rowCount).toBeGreaterThan(0);
   await transaction(pool,async tx=>{
    await tx.query("SET LOCAL lock_timeout='500ms'");
    const first={...scope,account_id:wallets[0].account_id};await lockExecutionAccount(tx,first);
    await grant(tx,first,systemClock,{idempotency_key:'parallel-grant',source:'purchase',external_reference:'fixture',amount_units:'10',terms_version:'test',expires_at:null});
   });
   await held.query('COMMIT');const result=await response!;
   expect(result.statusCode).toBe(200);expect(result.json().data.map((r:any)=>r.id)).toEqual(wallets.map(w=>w.id));
   // First row is its earlier consistent snapshot, not a fake atomic snapshot of the whole list.
   expect(result.json().data[0].balance_units).toBe('0');
   const refreshed=await app.inject({method:'GET',url:'/v1/admin/wallets',headers:{authorization:`Bearer ${token.token}`}});
   expect(refreshed.json().data[0].balance_units).toBe('10');
  }finally{await held.query('ROLLBACK');held.release();await response;await app.close()}
 });
});
