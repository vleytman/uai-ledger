import {afterAll,describe,it,expect,vi} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createPool,transaction,type SqlExecutor} from '../src/index.js';

const url=process.env.DATABASE_URL,admin=url?new pg.Pool({connectionString:url,max:1}):null;
afterAll(async()=>{await admin?.end()});
const pid=async(db:SqlExecutor)=>(await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
// As when PostgreSQL or a pooler restarts, or the network drops the connection.
const terminate=async(backend:number)=>{await admin!.query('SELECT pg_terminate_backend($1)',[backend]);await delay(200)};

describe.skipIf(!url)('pool connection loss',()=>{
 it('keeps the process alive and reconnects when a connection breaks idle in the pool, checked out between queries, or inside a transaction',async()=>{
  vi.stubEnv('UAI_DB_POOL_MAX','1');
  const errors=vi.spyOn(console,'error').mockImplementation(()=>{});
  const pool=createPool(url,'worker');
  try{
   const idle=await pid(pool);await terminate(idle);
   const second=await pid(pool);expect(second).not.toBe(idle);
   // A checked-out client has no pool listener: its error used to end the process.
   const client=await pool.connect();const held=await pid(client);await terminate(held);
   await expect(client.query('SELECT 1')).rejects.toThrow();client.release();
   const third=await pid(pool);expect(third).not.toBe(held);
   await expect(transaction(pool,async tx=>{await terminate(await pid(tx));return 'unreachable'})).rejects.toThrow();
   expect(await pid(pool)).toBeGreaterThan(0);
   expect(errors.mock.calls.flat()).toEqual(expect.arrayContaining(['postgres_pool_connection_error','postgres_client_connection_error']));
   expect(JSON.stringify(errors.mock.calls)).not.toContain(url!.split('@').pop()!);
  }finally{errors.mockRestore();await pool.end();vi.unstubAllEnvs()}
 });
});
