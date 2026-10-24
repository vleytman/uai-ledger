import {afterAll,describe,it,expect} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool,transaction} from '../../db/src/index.js';
import {ManualClock,id,systemClock} from '../../contracts/src/index.js';
import {enqueue,leaseNext} from '../../execution/src/index.js';
import {recordAdmissionIntent,acquireDurable} from '../src/admission.js';
import {QuotaStore} from '../src/quota.js';
const pool=process.env.DATABASE_URL?createPool():null,url=process.env.REDIS_URL;
afterAll(async()=>{await pool?.end()});

describe.skipIf(!pool||!url)('fair order within a quota group',()=>{
 it('admits the oldest waiting call first although a younger one asks first every round, and forgets a waiter that never comes back',async()=>{
  const scope={organization_id:id('org'),application_id:id('app'),account_id:id('account')},group=id('quota'),window=1500;
  await pool!.query("INSERT INTO provider_quota_groups(id,organization_id,name,provider,scope,recovery_epoch,source,concurrency_limit) VALUES($1,$2,$1,'fake','{}','epoch','synthetic',100)",[group,scope.organization_id]);
  await pool!.query("INSERT INTO provider_quota_rules(group_id,key,metric,capacity,window_ms) VALUES($1,'tokens','tokens',100,$2)",[group,window]);
  const store=new QuotaStore(url!,id('test'),group),grace=QuotaStore.waiterGraceMs;
  // Seniority is the enqueue time: each call below is enqueued one second after the previous one.
  const enqueued=new ManualClock(new Date(Date.now()-60000));
  const call=async()=>{
   enqueued.advance(1000);
   const request=await transaction(pool!,tx=>enqueue(tx,scope,enqueued,{operation_id:id('op'),component:'text',client_request_key:id('request'),input_hash:'test',input_ref:'test',route:{primary:{connection_id:'fake',model:'fake',endpoint_scope:'fake',max_cost_units:'0'},period_budget_key:'test',request_risk_limit_units:'0',incident_risk_limit_units:'0'},max_units:'0',deadline_at:new Date(Date.now()+60000)}));
   return request.id as string;
  };
  // Every attempt is a fresh lease and intent, as when the worker takes the call again at its retry time.
  const attempt=async(request:string,amount:number)=>{
   const lease=await transaction(pool!,tx=>leaseNext(tx,systemClock,'test',{scope,account:100,application:100},undefined,request));
   const input={id:id('admission'),group_id:group,request_id:request,fence:String(lease.fencing_token),demands:[{key:'tokens',capacity:100,window_ms:window,amount}]};
   await recordAdmissionIntent(pool!,input);const result=await acquireDurable(pool!,store,input);
   await pool!.query("UPDATE execution_requests SET execution_status='queued',lease_owner=NULL,lease_expires_at=NULL WHERE id=$1",[request]);
   return result;
  };
  try{
   await store.connect();
   const old=await call(),young=await call(),filler=await call();
   expect((await attempt(filler,50)).allowed).toBe(true);
   expect(await attempt(old,60)).toMatchObject({allowed:false,reason:'limited'});
   // 50+50 fits the window, but the older call's 60 is reserved first. The two never fit together,
   // so without an order the younger call, asking first every round, would always win.
   expect(await attempt(young,50)).toMatchObject({allowed:false,reason:'limited',details:{ahead:1}});
   const order:string[]=[];
   for(let round=0;round<60&&order.length<2;round++){
    if(!order.includes('young')&&(await attempt(young,50)).allowed)order.push('young');
    if(!order.includes('old')&&(await attempt(old,60)).allowed)order.push('old');
    await delay(100);
   }
   expect(order).toEqual(['old','young']);

   // A waiter that never comes back keeps its place only until its retry time plus the grace.
   QuotaStore.waiterGraceMs=1000;
   await delay(window);
   const gone=await call(),late=await call(),fill=await call();
   expect((await attempt(fill,90)).allowed).toBe(true);
   const refused=await attempt(gone,95);expect(refused).toMatchObject({allowed:false,reason:'limited'});
   const lapses=(refused as {retry_at:number}).retry_at+1000;
   expect(await attempt(late,10)).toMatchObject({allowed:false,details:{ahead:1}});
   // The window is empty again, yet 95 stays reserved for the absent caller until it lapses.
   await delay(Math.max(0,(refused as {retry_at:number}).retry_at+200-Date.now()));
   expect(await attempt(late,10)).toMatchObject({allowed:false,details:{ahead:1}});
   await delay(Math.max(0,lapses+100-Date.now()));
   expect((await attempt(late,10)).allowed).toBe(true);
  }finally{
   QuotaStore.waiterGraceMs=grace;
   await pool!.query("UPDATE execution_requests SET execution_status='canceled',lease_expires_at=NULL WHERE organization_id=$1",[scope.organization_id]);await store.close();
  }
 },30000);
});
