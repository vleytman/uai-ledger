import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,type AddressInfo} from 'node:net';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {isolatedTestDatabase} from '../../db/test/isolated-database.js';
import {transaction} from '../../db/src/index.js';
import {id,systemClock} from '../../contracts/src/index.js';
import {enqueue,leaseNext} from '../../execution/src/index.js';
import {QuotaStore} from '../src/quota.js';
import {recordAdmissionIntent,acquireDurable} from '../src/admission.js';
const enabled=process.env.UAI_TEST_REDIS_RESTART==='1'&&!!process.env.DATABASE_URL;
const database=isolatedTestDatabase(process.env.DATABASE_URL),exec=promisify(execFile);
beforeAll(async()=>{if(enabled)await database.initialize()});
afterAll(async()=>{await database.close()});
describe.skipIf(!enabled)('Dedicated Redis restart and persistence rollback',()=>{
 it('rebuilds consumed quota after restart and rollback to an older AOF without double counting permits',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'uai-redis-restart-')),data=join(directory,'data'),backup=join(directory,'backup'),container=`uai-restart-${id('test')}`;
  await mkdir(data);const pool=database.pool!,scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota');
  const docker=async(...args:string[])=>(await exec('docker',args,{timeout:30000})).stdout.trim();
  const listener=createServer();await new Promise<void>(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const hostPort=(listener.address() as AddressInfo).port;await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
  let store:QuotaStore|undefined;
  const ready=async()=>{await expect.poll(async()=>{try{return await docker('exec',container,'redis-cli','ping')}catch{return ''}},{timeout:10000}).toBe('PONG')};
  try{
   await docker('run','-d','--name',container,'-p',`127.0.0.1:${hostPort}:6379`,'-v',`${data}:/data`,'redis:7.4-alpine','redis-server','--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction');await ready();
   const open=async()=>{const port=(await docker('port',container,'6379/tcp')).split(':').at(-1);store=new QuotaStore(`redis://127.0.0.1:${port}`,'restart-test',group);store.redis.on('error',()=>{});await store.connect();return store};
   await pool.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source) VALUES($1,$2,$1,'fake','{}','epoch','synthetic')",[group,scope.organization_id]);
   await pool.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'requests','requests',2,3600000)",[group]);
   await open();await store!.markRestored('epoch');await store!.close();store=undefined;
   await docker('stop',container);await cp(data,backup,{recursive:true});await docker('start',container);await ready();await open();
   const add=async()=>{
    const request=await transaction(pool,tx=>enqueue(tx,scope,systemClock,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'synthetic',input_ref:'synthetic',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'fake',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+600000)}));
    const lease=await transaction(pool,tx=>leaseNext(tx,systemClock,'test',{scope,account:10,application:10,lease_ms:600000},undefined,request.id));
    const input={id:id('admission'),group_id:group,request_id:request.id,fence:String(lease.fencing_token),demands:[{key:'requests',capacity:2,amount:1,window_ms:3600000}]};await recordAdmissionIntent(pool,input);return input;
   };
   const first=await add(),second=await add();
   expect((await acquireDurable(pool,store!,first)).allowed).toBe(true);expect((await acquireDurable(pool,store!,second)).allowed).toBe(true);
   await store!.close();store=undefined;await docker('restart',container);await ready();await open();
   expect(await acquireDurable(pool,store!,first)).toMatchObject({allowed:true,replayed:true});
   expect(await store!.acquire('epoch','over-capacity',first.demands)).toMatchObject({allowed:false,reason:'limited'});
   await store!.close();store=undefined;await docker('stop',container);
   await rm(data,{recursive:true,force:true});await cp(backup,data,{recursive:true});await docker('start',container);await ready();await open();
   const third=await add();
   expect(await acquireDurable(pool,store!,third)).toMatchObject({allowed:false,reason:'limited'});
   // Restart inside a recovery attempt: a late owner must not open the new server's gate.
   await store!.isReady('epoch');await store!.closeGate();
   await docker('restart',container);await ready();
   await expect.poll(()=>store!.redis.status,{timeout:10000}).toBe('ready');
   await expect(store!.markRestored('epoch')).rejects.toThrow('quota_redis_generation_changed');
   await expect(store!.restore(first.id,Date.now(),first.demands)).rejects.toThrow('quota_restore_failed');
   expect(await store!.snapshot('epoch',first.demands)).toMatchObject({ready:false,reason:'not_ready'});
   const fourth=await add();expect(await acquireDurable(pool,store!,fourth)).toMatchObject({allowed:false,reason:'limited'});
   expect((await pool.query("SELECT count(*)::int n FROM dispatch_admissions WHERE group_id=$1 AND state='admitted'",[group])).rows[0].n).toBe(2);
   expect((await pool.query('SELECT count(*)::int n FROM execution_attempts')).rows[0].n).toBe(0);
  }finally{await store?.close().catch(()=>{});await docker('rm','-f',container).catch(()=>{});await rm(directory,{recursive:true,force:true})}
 },60000);
});
