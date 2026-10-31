import {afterAll,beforeAll,describe,it,expect,vi} from 'vitest';
import {mkdir,writeFile} from 'node:fs/promises';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {id} from '../../contracts/src/index.js';
import {seedLoadFixture} from '../../../scripts/load/fixture.js';
import {createApi} from '../../../apps/api/src/server.js';

const database=isolatedTestDatabase(process.env.DATABASE_URL),enabled=!!process.env.DATABASE_URL;
beforeAll(async()=>{if(enabled)await database.initialize()});afterAll(()=>database.close());

describe.skipIf(!enabled)('concurrent call admission',()=>{
 it('admits calls of different accounts side by side, keeps each account limit exact and overshoots the application limit only by calls admitted at the same moment',async()=>{
  vi.stubEnv('UAI_EXECUTION_BACKEND','bullmq');vi.stubEnv('UAI_ALLOW_REAL_PROVIDERS','false');
  const pool=database.pool!,f=await seedLoadFixture(pool,30),api=createApi(pool),connections=pool.options.max!;
  const invoke=(account:number)=>api.inject({method:'POST',url:'/v1/invocations',headers:{authorization:`Bearer ${f.token}`,'idempotency-key':id('invoke')},payload:{account_id:f.accounts[account]!.account_id,budget:{max_units:'24000000'},profile:'text.standard',input:{text:`Admission ${account}`},parameters:{max_output_tokens:100}}});
  const timed=async(account:number)=>{const started=performance.now();const response=await invoke(account);return {status:response.statusCode,body:response.json(),ms:performance.now()-started}};
  // Nothing executes here: every accepted call stays queued and counts against the limits.
  expect((await timed(0)).status).toBe(202);
  await pool.query('UPDATE execution_admission_policies SET account_limit=1000,application_limit=100000');
  const serial:number[]=[];for(let i=0;i<10;i++)serial.push((await timed(i%30)).ms);
  const median=[...serial].sort((a,b)=>a-b)[5]!;
  const started=performance.now();const parallel=await Promise.all(Array.from({length:60},(_,i)=>timed(i%30)));const wall=performance.now()-started;
  expect(parallel.every(call=>call.status===202)).toBe(true);
  // One at a time, 60 calls take about 60 medians; side by side they share the pool's connections.
  const ratio=wall/(60*median);

  // The application limit: no call is refused before it is reached; beyond it, only calls that committed together slip in.
  const queued=async()=>(await pool.query("SELECT count(*)::int AS n FROM execution_requests WHERE application_id=$1 AND execution_status='queued'",[f.scope.application_id])).rows[0].n as number;
  const before=await queued();
  await pool.query('UPDATE execution_admission_policies SET account_limit=$1,application_limit=$1',[before+20]);
  const burst=await Promise.all(Array.from({length:60},(_,i)=>timed(i%30)));
  const accepted=burst.filter(call=>call.status===202).length,refused=burst.filter(call=>call.status===429);
  expect(refused.every(call=>call.body.error.details.reason==='application_backlog')).toBe(true);
  expect(accepted).toBeGreaterThanOrEqual(20);expect(accepted).toBeLessThan(20+connections);
  expect(await queued()).toBe(before+accepted);

  // Each account's limit stays exact: its admissions are serialized by the account barrier.
  await pool.query('UPDATE execution_admission_policies SET account_limit=$1,application_limit=100000',[(await pool.query("SELECT count(*)::int AS n FROM execution_requests WHERE account_id=$1 AND execution_status='queued'",[f.accounts[7]!.account_id])).rows[0].n+3]);
  const own=await Promise.all(Array.from({length:12},()=>timed(7)));
  expect(own.filter(call=>call.status===202)).toHaveLength(3);
  expect(own.filter(call=>call.status===429).every(call=>call.body.error.details.reason==='account_backlog')).toBe(true);

  const report={serial_median_ms:Math.round(median),parallel_calls:60,parallel_wall_ms:Math.round(wall),wall_to_serial_ratio:Math.round(ratio*100)/100,pool_connections:connections,application_limit_overshoot:accepted-20};
  await mkdir('.data/test-reports',{recursive:true});await writeFile('.data/test-reports/admission-concurrency.json',JSON.stringify(report,null,2)+'\n');
  expect(ratio).toBeLessThan(0.6);
 },120000);
});
