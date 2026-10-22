import {afterEach,expect,test,vi} from 'vitest';
import {createPool,type DatabaseRole} from '../src/index.js';
const pools:ReturnType<typeof createPool>[]=[];
afterEach(async()=>{await Promise.all(pools.splice(0).map(pool=>pool.end()));vi.unstubAllEnvs();vi.restoreAllMocks()});
const make=(role:DatabaseRole)=>{const pool=createPool('postgresql://fixture@localhost/unused',role);pools.push(pool);return pool};
test('uses a finite role budget and connection wait without connecting during construction',()=>{
 for(const [role,max] of [['api',10],['worker',8],['scheduler',4],['tool',10]] as const){
  const pool=make(role);expect(pool.options).toMatchObject({max,connectionTimeoutMillis:5000,idleTimeoutMillis:30000,application_name:`uai-${role}`});expect(pool.totalCount).toBe(0);
 }
});
test('role overrides take precedence over the common limit and invalid limits fail closed',()=>{
 vi.stubEnv('UAI_DB_POOL_MAX','6');vi.stubEnv('UAI_DB_POOL_MAX_WORKER','3');
 expect(make('worker').options.max).toBe(3);expect(make('api').options.max).toBe(6);
 for(const invalid of ['0','-1','1.5','NaN','Infinity','1001','',' 4','4ms']){
  vi.stubEnv('UAI_DB_POOL_MAX_WORKER',invalid);expect(()=>make('worker')).toThrow('Invalid UAI_DB_POOL_MAX_WORKER');
 }
});
test('validates timeout settings and logs no connection details on idle socket failure',()=>{
 vi.stubEnv('UAI_DB_CONNECT_TIMEOUT_MS','7500');vi.stubEnv('UAI_DB_IDLE_TIMEOUT_MS','60000');
 const pool=make('api');expect(pool.options).toMatchObject({connectionTimeoutMillis:7500,idleTimeoutMillis:60000});
 const log=vi.spyOn(console,'error').mockImplementation(()=>{});
 expect(()=>pool.emit('error',new Error('private database details'))).not.toThrow();
 expect(log).toHaveBeenCalledExactlyOnceWith('postgres_pool_connection_error');
 vi.stubEnv('UAI_DB_CONNECT_TIMEOUT_MS','0');expect(()=>make('scheduler')).toThrow('Invalid UAI_DB_CONNECT_TIMEOUT_MS');
});
test.skipIf(!process.env.DATABASE_URL)('caps real PostgreSQL connections, times out a saturated waiter and recovers after release',async()=>{
 vi.stubEnv('UAI_DB_POOL_MAX_WORKER','2');vi.stubEnv('UAI_DB_CONNECT_TIMEOUT_MS','200');
 const pool=createPool(process.env.DATABASE_URL,'worker');pools.push(pool);
 const first=await pool.connect(),second=await pool.connect();
 try{
  expect(pool.totalCount).toBe(2);
  await expect(pool.connect()).rejects.toThrow(/timeout/i);
  expect(pool.totalCount).toBe(2);expect(pool.waitingCount).toBe(0);
 }finally{first.release();second.release()}
 const result=await pool.query("SELECT current_setting('application_name') AS name");expect(result.rows[0].name).toBe('uai-worker');expect(pool.totalCount).toBeLessThanOrEqual(2);
});
