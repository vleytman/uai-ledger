import {afterAll,describe,it,expect,vi} from 'vitest';
import {createPool} from '../../../packages/db/src/index.js';
import {createApi} from './server.js';

const enabled=!!process.env.DATABASE_URL;
let pool:ReturnType<typeof createPool>|undefined;
afterAll(async()=>{await pool?.end();vi.unstubAllEnvs()});

describe.skipIf(!enabled)('API when the database pool is exhausted',()=>{
 it('answers 503 retryable instead of 500, and serves again once a connection is free',async()=>{
  vi.stubEnv('UAI_DB_POOL_MAX','1');vi.stubEnv('UAI_DB_CONNECT_TIMEOUT_MS','200');
  pool=createPool(process.env.DATABASE_URL,'api');const app=createApi(pool);
  const call=()=>app.inject({method:'GET',url:'/v1/wallets/wallet_missing',headers:{authorization:'Bearer uai_missing_token'}});
  const held=await pool.connect();
  try{
   const busy=await call();
   expect(busy.statusCode).toBe(503);
   expect(busy.json().error).toMatchObject({code:'platform_unavailable',retryable:true});
  }finally{held.release()}
  // The same request, with a free connection, reaches the real answer.
  expect((await call()).statusCode).toBe(401);
  await app.close();
 });
});
